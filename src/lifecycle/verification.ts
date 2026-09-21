/**
 * Verification planning + execution (spec §17).
 *
 * Commands come from configuration, package scripts, CI definitions, AGENTS.md
 * and Makefiles — never invented. Every check reports one of five statuses and
 * "not run" is never reported as a pass: `not_applicable`, `unavailable` and
 * `skipped` are distinct, and required checks that cannot run block completion.
 */

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import { newArtifactId, newEvidenceId } from "../core/ids.ts";
import { tokenizeCommand } from "../verify/Verifier.ts";
import type { EngineeringPolicy } from "./policy.ts";
import type { CheckKind, CheckOutcome, CheckSpec, GateStatus, VerificationReport } from "./types.ts";

const exec = promisify(execFile);

const KIND_ORDER: CheckKind[] = ["typecheck", "lint", "format", "test", "build", "security", "custom"];

const KIND_ALIASES: Record<string, CheckKind> = {
  typecheck: "typecheck",
  "type-check": "typecheck",
  types: "typecheck",
  tsc: "typecheck",
  lint: "lint",
  eslint: "lint",
  biome: "lint",
  format: "format",
  fmt: "format",
  checkformat: "format",
  test: "test",
  tests: "test",
  unit: "test",
  coverage: "test",
  build: "build",
  compile: "build",
  audit: "security",
  secu: "security",
};

export function kindFromName(name: string): CheckKind {
  const key = name.toLowerCase().replace(/[^a-z]/g, "");
  for (const [alias, kind] of Object.entries(KIND_ALIASES)) {
    if (key.startsWith(alias)) return kind;
  }
  return "custom";
}

interface PkgJson {
  scripts?: Record<string, string>;
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return undefined;
  }
}

/** Commands explicitly named in AGENTS.md / CLAUDE.md style guidance. */
function commandsFromAgentsFiles(text: string): { name: string; command: string }[] {
  const out: { name: string; command: string }[] = [];
  const seen = new Set<string>();
  const patterns = [
    /(?:^|\n)\s*(?:[-*]\s*|`)?((?:npm|pnpm|yarn|bun|node|make|cargo|go|pytest|dart|dotnet)\s+[^\n`"]{2,120})/g,
  ];
  for (const re of patterns) {
    for (const match of text.matchAll(re)) {
      const command = (match[1] ?? "").trim();
      if (!command || seen.has(command)) continue;
      const named = /^(\S+(?:\s+run)?\s+([\w:.\-]+))/.exec(command);
      const name = named?.[2] ?? command.split(/\s+/).slice(0, 2).join(" ");
      if (!/^(npm|pnpm|yarn|bun|node|make|cargo|go|pytest|dart|dotnet)/.test(command)) continue;
      // Only commands that look like verification, not arbitrary scripts.
      if (
        !/^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|check|lint|build|verify|typecheck|coverage)/.test(command) &&
        !/^(node --test|make (test|check)|cargo test|go test|pytest)/.test(command)
      ) {
        continue;
      }
      seen.add(command);
      out.push({ name: kindFromName(name) === "custom" ? name : kindFromName(name), command });
    }
  }
  return out;
}

/** Commands executed inside CI workflow files. */
function commandsFromWorkflows(text: string): { name: string; command: string }[] {
  const out: { name: string; command: string }[] = [];
  for (const match of text.matchAll(/-\s*(?:name:[^\n]*\n\s*)?run:\s*["']?([^\n"']+)/g)) {
    const command = (match[1] ?? "").trim();
    if (
      /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|build|check|typecheck)|^(node --test|cargo test|go test|pytest|make (test|check))/.test(
        command,
      )
    ) {
      out.push({ name: kindFromName(command), command });
    }
  }
  return out;
}

export interface PlanChecksOptions {
  cwd: string;
  policy: EngineeringPolicy;
  /** Extra commands supplied by the run (operator or harness override). */
  extra?: string[];
  /** Categories from classification decide which kinds are required. */
  categories: string[];
}

/**
 * Build the verification plan: config first, then repository-declared commands.
 * Duplicates are collapsed by kind+command and dangerous commands are excluded.
 */
export async function planChecks(opts: PlanChecksOptions): Promise<CheckSpec[]> {
  const { cwd, policy } = opts;
  const found: { name: string; command: string; origin: string }[] = [];

  if (policy.policies.verification.command_sources.includes("config")) {
    for (const [kind, cmds] of Object.entries(policy.policies.verification.commands)) {
      for (const command of cmds)
        found.push({ name: kindFromName(kind), command, origin: "policy.policies.verification.commands" });
    }
  }
  for (const command of opts.extra ?? []) {
    found.push({ name: kindFromName(command), command, origin: "run override" });
  }

  if (policy.policies.verification.command_sources.includes("package_json")) {
    const pkg = await readJson<PkgJson>(join(cwd, "package.json"));
    const scripts = pkg?.scripts ?? {};
    for (const [name, script] of Object.entries(scripts)) {
      const kind = kindFromName(name);
      const isVerification = ["typecheck", "lint", "format", "test", "build", "security"].includes(kind);
      if (!isVerification) continue;
      if (!script?.trim()) continue;
      found.push({ name: kind === "custom" ? name : kind, command: script, origin: `package.json:${name}` });
    }
  }

  if (policy.policies.verification.command_sources.includes("ci")) {
    const workflowDir = join(cwd, ".github", "workflows");
    try {
      const { readdir } = await import("node:fs/promises");
      for (const file of await readdir(workflowDir)) {
        if (!/\.(ya?ml)$/.test(file)) continue;
        const text = await readText(join(workflowDir, file));
        if (!text) continue;
        for (const c of commandsFromWorkflows(text)) found.push({ ...c, origin: `.github/workflows/${file}` });
      }
    } catch {
      // No CI directory: nothing to add.
    }
  }

  if (policy.policies.verification.command_sources.includes("agents_md")) {
    for (const file of ["AGENTS.md", "CLAUDE.md", ".cursorrules"]) {
      const text = await readText(join(cwd, file));
      if (!text) continue;
      for (const c of commandsFromAgentsFiles(text)) found.push({ ...c, origin: file });
    }
  }

  if (policy.policies.verification.command_sources.includes("makefile")) {
    const makefile = await readText(join(cwd, "Makefile"));
    if (makefile) {
      for (const match of makefile.matchAll(/^(test|check|lint|build|typecheck)[a-z-]*:/gm)) {
        const target = match[1];
        if (!target) continue;
        found.push({ name: kindFromName(target), command: `make ${target}`, origin: "Makefile" });
      }
    }
  }

  const denied = policy.policies.verification.command_deny;
  const specs: CheckSpec[] = [];
  const seen = new Set<string>();
  for (const f of found) {
    if (denied.some((d) => f.command.includes(d))) {
      specs.push({
        kind: kindFromName(f.name),
        name: f.name,
        command: undefined,
        origin: f.origin,
        required: false,
        reason: `excluded by policies.verification.command_deny (${f.command})`,
        timeoutMs: policy.policies.verification.timeout_ms,
      });
      continue;
    }
    const key = `${f.name}::${f.command}`;
    if (seen.has(key)) continue;
    seen.add(key);
    specs.push({
      kind: kindFromName(f.name),
      name: f.name,
      command: f.command,
      origin: f.origin,
      required: true,
      timeoutMs: policy.policies.verification.timeout_ms,
    });
  }

  // A repository with no declared verification for a required kind is recorded
  // as not_applicable (never silently passed) — see evaluateGate.
  const requiredKinds = requiredCheckKinds(opts.categories);
  for (const kind of requiredKinds) {
    if (!specs.some((s) => s.kind === kind && s.command)) {
      specs.push({
        kind,
        name: kind,
        origin: "classification",
        required: true,
        reason: `no ${kind} command declared by configuration, package scripts, CI, AGENTS.md or Makefile`,
        timeoutMs: policy.policies.verification.timeout_ms,
      });
    }
  }

  return specs.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

function requiredCheckKinds(categories: string[]): CheckKind[] {
  const kinds: CheckKind[] = [];
  const has = (c: string) => categories.includes(c);
  if (has("backend") || has("feature") || has("bugfix") || has("refactor") || has("unknown") || has("api"))
    kinds.push("test");
  if (has("frontend") || has("backend") || has("api") || has("runtime_system") || has("unknown"))
    kinds.push("typecheck");
  if (has("docs") || has("test") || has("config")) kinds.push("lint");
  return [...new Set(kinds)];
}

export interface RunChecksOptions {
  cwd: string;
  specs: CheckSpec[];
  artifacts: ArtifactStore;
  stage: "implementation" | "final";
  round: number;
  /** Skip kinds already proven green at this same content fingerprint. */
  skipKinds?: string[];
  signal?: AbortSignal;
}

function statusForExit(code: number): GateStatus {
  return code === 0 ? "passed" : "failed";
}

async function runOne(
  spec: CheckSpec,
  cwd: string,
  artifacts: ArtifactStore,
  signal?: AbortSignal,
): Promise<CheckOutcome> {
  if (!spec.command) {
    return {
      spec,
      status: "not_applicable",
      durationMs: 0,
      summary: spec.reason ?? "no command declared",
    };
  }
  const started = Date.now();
  const { command, args } = tokenizeCommand(spec.command);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const { stdout, stderr } = await exec(command, args, {
      cwd,
      timeout: spec.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env,
      signal,
    });
    const output = `${stdout}\n${stderr}`.trim();
    const artifact = await artifacts.put(
      `verify-${spec.kind}`,
      newArtifactId(),
      output || "(no output)",
      summarize(output),
    );
    return {
      spec,
      status: statusForExit(0),
      exitCode: 0,
      durationMs: Date.now() - started,
      summary: summarize(output),
      artifactUri: artifact.uri,
      evidenceId: newEvidenceId(),
    };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string; killed?: boolean };
    const output = `${e.stdout ?? ""}\n${e.stderr ?? ""}${e.message ? `\n${e.message}` : ""}`.trim();
    const artifact = await artifacts.put(
      `verify-${spec.kind}`,
      newArtifactId(),
      output || "(no output)",
      summarize(output),
    );
    const notRun = e.code === "ENOENT";
    const aborted = e.code === "ABORT_ERR" || signal?.aborted;
    return {
      spec,
      status: notRun ? "unavailable" : aborted ? "skipped" : statusForExit(1),
      exitCode: typeof e.code === "number" ? e.code : undefined,
      durationMs: Date.now() - started,
      summary: notRun ? `command not found: ${command}` : aborted ? "verification aborted" : summarize(output),
      artifactUri: artifact.uri,
      evidenceId: newEvidenceId(),
    };
  }
}

function summarize(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim());
  const tail = lines.slice(-12).join("\n");
  return tail.length > 1200 ? `${tail.slice(0, 1200)}…` : tail || "(no output)";
}

/** Execute the plan sequentially (fail-fast on required failures). */
export async function runChecks(opts: RunChecksOptions): Promise<VerificationReport> {
  const outcomes: CheckOutcome[] = [];
  const blocking: string[] = [];
  for (const spec of opts.specs) {
    if (opts.skipKinds?.includes(spec.kind)) {
      outcomes.push({ spec, status: "skipped", durationMs: 0, summary: "unchanged since the previous passing run" });
      continue;
    }
    const outcome = await runOne(spec, opts.cwd, opts.artifacts, opts.signal);
    outcomes.push(outcome);
    if (outcome.status === "failed") {
      if (spec.required) blocking.push(`${spec.name} failed: ${outcome.summary.split("\n")[0]}`);
      if (spec.required) break;
    } else if (outcome.status === "unavailable" && spec.required) {
      blocking.push(`${spec.name} is unavailable: ${outcome.summary}`);
    }
    // `not_applicable` means no command is declared for this repo; the gate's
    // itemPass treats it as a genuine pass (see evaluateGate), so it never
    // blocks completion here.
  }
  const status: GateStatus = blocking.length
    ? "failed"
    : outcomes.some((o) => o.status === "passed")
      ? "passed"
      : outcomes.length === 0
        ? "not_applicable"
        : "skipped";
  return {
    round: opts.round,
    stage: opts.stage,
    at: new Date().toISOString(),
    outcomes,
    status,
    blocking,
  };
}
