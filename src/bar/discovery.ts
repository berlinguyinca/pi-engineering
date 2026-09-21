/**
 * BAR discovery collection (steps .../implement-discovery-collection).
 *
 * Scans a repository's structure — specs/ADRs/designs, source, tests, configs —
 * and surfaces machine-readable inputs to the audit pipeline. Discovery is
 * deterministic: it reports what is on disk, not what a historical claim says.
 * Historical IMPLEMENTED/COMPLETE claims are treated as untrusted inputs, not
 * as evidence.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export interface DiscoveryInput {
  /** Directory scanned. */
  root: string;
  sourceRevision: string | null;
  /** Spec/design/ADR documents found. */
  specs: string[];
  /** Source files found (by extension). */
  sourceFiles: string[];
  /** Test files found. */
  testFiles: string[];
  /** Config/declarative files found. */
  configFiles: string[];
  /** Historical claims found (e.g. in docs/*.md completion/status files). Untrusted. */
  historicalClaims: string[];
  /** Surfaces/entrypoints that hint at runtime behavior. */
  entrypoints: string[];
}

const SOURCE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".cs",
  ".rb",
]);
const TEST_MARKERS = ["test", "spec", "tests", "__tests__"];
const CONFIG_EXTS = new Set([".json", ".yaml", ".yml", ".toml", ".ini", ".env", ".lock"]);
const SPEC_DIRS = ["docs/specs", "docs/design", "docs/adr", "specs", "design"];
const CLAIM_MARKERS = ["complete", "implemented", "verified", "status"];

interface ScanOpts {
  /** Skip directories (always excludes node_modules, .git). */
  ignoreDirs?: string[];
  maxDepth?: number;
}

/** Deterministically discover repository structure. */
export function discoverRepo(root: string, opts: ScanOpts = {}): DiscoveryInput {
  const ignore = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "coverage",
    ".next",
    ".pi-eng",
    ...(opts.ignoreDirs ?? []),
  ]);
  const maxDepth = opts.maxDepth ?? 12;
  const specs: string[] = [];
  const sourceFiles: string[] = [];
  const testFiles: string[] = [];
  const configFiles: string[] = [];
  const historicalClaims: string[] = [];
  const entrypoints: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    entries.sort();
    for (const entry of entries) {
      if (ignore.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(root, full).replace(/\\/g, "/");
      if (st.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      const ext = entry.slice(entry.lastIndexOf(".")).toLowerCase();
      const lower = rel.toLowerCase();
      // Specs / design docs.
      if (SPEC_DIRS.some((d) => rel.startsWith(d)) && (ext === ".md" || ext === ".adoc")) {
        specs.push(rel);
      } else if (ext === ".md" && lower.includes("spec")) {
        specs.push(rel);
      }
      // Source.
      if (SOURCE_EXTS.has(ext) && !TEST_MARKERS.some((t) => lower.includes(t))) {
        sourceFiles.push(rel);
        // Entrypoint heuristic: index/main files at package boundaries.
        if (/index|main|cli|server|entry/.test(entry.toLowerCase())) entrypoints.push(rel);
      }
      // Tests.
      if (ext === ".ts" || ext === ".js") {
        if (TEST_MARKERS.some((t) => lower.includes(t))) testFiles.push(rel);
      }
      // Config.
      if (CONFIG_EXTS.has(ext) && !lower.includes("package-lock")) {
        configFiles.push(rel);
      }
      // Historical claims: docs markdown mentioning completion/status markers.
      if (ext === ".md" && CLAIM_MARKERS.some((c) => lower.includes(c))) {
        historicalClaims.push(rel);
      }
    }
  };

  walk(root, 0);
  return { root, sourceRevision: null, specs, sourceFiles, testFiles, configFiles, historicalClaims, entrypoints };
}
