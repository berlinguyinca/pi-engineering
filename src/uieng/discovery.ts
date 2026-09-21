/**
 * Automatic repository/UI discovery (docs/specs/autonomous-ui-engineering/
 * pi-engineering/01-auto-policy.md).
 *
 * Runs automatically on repository discovery — NO slash command and no
 * remembered prompt is required. It scans the working tree with a bounded,
 * deterministic file walk and emits a typed {@link UiProfile} (shared schema in
 * src/uieng/schemas.ts) describing UI presence, framework, routes, components,
 * styling/design system, tokens, startup procedure, browser tests, responsive
 * targets and design docs.
 *
 * Reuse: the CAV change classifier (src/cav/classify.ts) is used to recognize
 * UI source files; discovery is intentionally self-contained so it can run in a
 * headless worker with no session state.
 */

import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { ChangeClassifier } from "../cav/classify.ts";
import { id as newId } from "../core/ids.ts";
import { validateRecord } from "./schemas.ts";
import type { UiProfile } from "./schemas.ts";

/** Directories never scanned (bounded walk). */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".pi-eng",
]);

/** Hard bounds so discovery is always cheap and deterministic. */
export const DISCOVERY_LIMITS = {
  /** Max files scanned per discovery run. */
  maxFiles: 4000,
  /** Max directories visited. */
  maxDirs: 2000,
} as const;

const COMPONENT_EXTS = new Set([".tsx", ".jsx", ".svelte", ".vue", ".astro"]);
const ROUTE_DIR_NAMES = new Set(["pages", "routes", "views", "screens", "app"]);

const FRAMEWORK_DEPS: ReadonlyArray<readonly [string, string]> = [
  ["next", "next"],
  ["astro", "astro"],
  ["nuxt", "nuxt"],
  ["@angular/core", "angular"],
  ["react", "react"],
  ["preact", "preact"],
  ["vue", "vue"],
  ["svelte", "svelte"],
  ["solid-js", "solid"],
] as const;

const STYLING_DEPS: ReadonlyArray<readonly [string, string]> = [
  ["tailwindcss", "tailwind"],
  ["@mui/material", "material-ui"],
  ["antd", "ant-design"],
  ["@chakra-ui/react", "chakra-ui"],
  ["@emotion/react", "emotion"],
  ["styled-components", "styled-components"],
  ["@radix-ui", "radix"],
  ["bootstrap", "bootstrap"],
  ["semantic-ui", "semantic-ui"],
] as const;

interface ScanState {
  files: string[];
  dirs: number;
  overflow: boolean;
}

/**
 * Deterministic bounded recursive file walk. Skips heavy/build directories and
 * stops once {@link DISCOVERY_LIMITS} are reached (overflow flagged).
 */
async function walk(root: string, state: ScanState, rel = ""): Promise<void> {
  if (state.dirs >= DISCOVERY_LIMITS.maxDirs || state.files.length >= DISCOVERY_LIMITS.maxFiles) {
    state.overflow = true;
    return;
  }
  state.dirs += 1;
  let entries;
  try {
    entries = await readdir(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (state.files.length >= DISCOVERY_LIMITS.maxFiles) {
      state.overflow = true;
      return;
    }
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(root, state, child);
    } else if (entry.isFile()) {
      state.files.push(child);
    }
  }
}

/** Read package.json scripts and dependencies, if present. */
async function readPackageJson(cwd: string): Promise<{ scripts: Record<string, string>; deps: string[] }> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, "package.json"), "utf-8")) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      scripts: { ...(raw.scripts ?? {}) },
      deps: [...Object.keys(raw.dependencies ?? {}), ...Object.keys(raw.devDependencies ?? {})],
    };
  } catch {
    return { scripts: {}, deps: [] };
  }
}

/** Read a JSON file and return parsed value, or undefined. */
async function readJson(cwd: string, rel: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(cwd, rel), "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

function detectFramework(deps: string[], componentFiles: string[]): { framework?: string; detected: string[] } {
  const detected: string[] = [];
  for (const [dep, label] of FRAMEWORK_DEPS) {
    if (deps.some((d) => d === dep)) detected.push(label);
  }
  if (componentFiles.some((f) => f.endsWith(".svelte"))) detected.push("svelte");
  if (componentFiles.some((f) => f.endsWith(".vue"))) detected.push("vue");
  if (componentFiles.some((f) => f.endsWith(".astro"))) detected.push("astro");
  if (componentFiles.some((f) => /\.tsx$/.test(f)) && !detected.includes("react")) detected.push("react");
  const unique = [...new Set(detected)];
  return { framework: unique[0], detected: unique };
}

function detectStyling(deps: string[]): { styling?: string; designSystem?: string } {
  const styling: string[] = [];
  const designSystems: string[] = [];
  for (const [dep, label] of STYLING_DEPS) {
    if (deps.some((d) => d === dep)) {
      if (["material-ui", "ant-design", "chakra-ui", "radix"].includes(label)) designSystems.push(label);
      else styling.push(label);
    }
  }
  return {
    styling: styling[0],
    designSystem: designSystems[0],
  };
}

function isTokenFile(file: string): boolean {
  const base = basename(file).toLowerCase();
  return (
    base === "tokens.json" ||
    base === "theme.json" ||
    /token/.test(base) ||
    /(^|\/)tokens\//.test(file) ||
    /(^|\/)design-tokens\//.test(file)
  );
}

/** Extract breakpoint-ish responsive targets from a parsed token/config object. */
function extractResponsiveTargets(value: unknown): string[] {
  if (value === null || typeof value !== "object") return [];
  const out = new Set<string>();
  const rec = value as Record<string, unknown>;
  const bp = (rec.breakpoints ?? rec.breakpoint ?? rec.screens) as Record<string, unknown> | undefined;
  if (bp && typeof bp === "object") {
    for (const [k, v] of Object.entries(bp)) {
      const label = typeof v === "string" ? `${k}:${v}` : k;
      out.add(label);
    }
  }
  return [...out];
}

function isBrowserTestFile(file: string): boolean {
  const base = basename(file).toLowerCase();
  return (
    /^playwright\.config/.test(base) ||
    /^cypress\.config/.test(base) ||
    /^vitest\.config/.test(base) ||
    /\.e2e\.(ts|js|tsx|jsx)$/.test(file) ||
    /(^|\/)e2e\//.test(file) ||
    /(^|\/)(playwright|cypress)\//.test(file)
  );
}

function isDesignDoc(file: string): boolean {
  const base = basename(file).toLowerCase();
  return (
    file.endsWith(".md") &&
    (/design/.test(base) ||
      /^ui/.test(base) ||
      /(^|\/)design\//.test(file) ||
      /(^|\/)ui-/.test(file) ||
      /(^|\/)ui\//.test(file))
  );
}

function isStartupScript(key: string): boolean {
  return ["dev", "build", "start", "preview", "serve"].includes(key);
}

/** Extract the value of a nested key from a parsed object (used for tokens). */
function pickTokens(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const rec = value as Record<string, unknown>;
  if ("tokens" in rec && rec.tokens && typeof rec.tokens === "object") return rec.tokens as Record<string, unknown>;
  if ("color" in rec || "colors" in rec || "spacing" in rec || "typography" in rec || "breakpoints" in rec) {
    return rec;
  }
  return undefined;
}

/**
 * Discover a repository's UI surface automatically and emit a typed UiProfile.
 * Deterministic and bounded; safe to run on every repository discovery.
 */
export async function discoverUiProfile(cwd: string): Promise<UiProfile> {
  const state: ScanState = { files: [], dirs: 0, overflow: false };
  await walk(cwd, state);
  const files = state.files;

  const pkg = await readPackageJson(cwd);
  const classifier = new ChangeClassifier();

  const componentFiles = files.filter((f) => COMPONENT_EXTS.has(extname(f).toLowerCase()));
  const routes: string[] = [];
  const components: string[] = [];
  for (const f of componentFiles) {
    const parts = f.split("/");
    const isRoute = parts.some((part) => ROUTE_DIR_NAMES.has(part)) || /(^|\/)(pages|routes|app)\//.test(f);
    if (isRoute) routes.push(f);
    else components.push(f);
  }

  const { framework, detected } = detectFramework(pkg.deps, componentFiles);
  const { styling, designSystem } = detectStyling(pkg.deps);

  const tokenFiles = files.filter(isTokenFile);
  const tokens: Record<string, unknown> = {};
  const responsiveTargets = new Set<string>();
  for (const tf of tokenFiles) {
    const parsed = await readJson(cwd, tf);
    if (parsed !== undefined) {
      const picked = pickTokens(parsed);
      if (picked) Object.assign(tokens, picked);
      for (const t of extractResponsiveTargets(parsed)) responsiveTargets.add(t);
    }
  }
  // Also scan tailwind config for screens/breakpoints.
  const tailwindConfig = files.find((f) => /tailwind\.config\.(c?js|ts|mjs)$/.test(f));
  if (tailwindConfig) {
    const parsed = await readJson(cwd, tailwindConfig);
    if (parsed !== undefined) for (const t of extractResponsiveTargets(parsed)) responsiveTargets.add(t);
  }

  const browserTests = files.filter(isBrowserTestFile);
  const designDocs = files.filter(isDesignDoc);

  // Reuse CAV classification to recognize UI source files (kinds includes "ui").
  const uiSourceCount = files.filter((f) => classifier.classify([f]).kinds.includes("ui")).length;

  const startup: UiProfile["startup"] = {};
  for (const [key, value] of Object.entries(pkg.scripts)) {
    if (isStartupScript(key) && typeof value === "string") (startup as Record<string, string>)[key] = value;
  }

  const ui_present = componentFiles.length > 0 || uiSourceCount > 0 || files.some((f) => /\.html$/.test(f));

  return {
    schema_version: 1,
    kind: "ui_profile",
    id: newId("UP"),
    discoveredAt: new Date().toISOString(),
    ui_present,
    framework,
    frameworks_detected: detected,
    routes,
    components,
    component_count: components.length,
    styling,
    design_system: designSystem,
    tokens: Object.keys(tokens).length > 0 ? tokens : undefined,
    token_files: tokenFiles,
    startup,
    browser_tests: browserTests,
    responsive_targets: [...responsiveTargets],
    design_docs: designDocs,
  };
}

/** Persist a UiProfile to a JSON file (round-trips through validateRecord). */
export async function persistUiProfile(profile: UiProfile, filePath: string): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(filePath, `${JSON.stringify(profile, null, 2)}\n`, "utf-8");
}

/** Load and validate a persisted UiProfile from a JSON file. */
export async function loadUiProfile(filePath: string): Promise<UiProfile | undefined> {
  try {
    const raw = JSON.parse(await readFile(filePath, "utf-8")) as unknown;
    return validateRecord("ui_profile", raw) ? (raw as UiProfile) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Automatic entry point: discover the UI surface and persist it to
 * `filePath`. Designed to be invoked on every repository discovery with no
 * slash command or remembered prompt. Returns the persisted profile.
 */
export async function discoverAndPersistUiProfile(cwd: string, filePath: string): Promise<UiProfile> {
  const profile = await discoverUiProfile(cwd);
  await persistUiProfile(profile, filePath);
  return profile;
}

export type { UiProfile };
