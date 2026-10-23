/**
 * Gate-evidence provider for the optional AutoSpec integration (T04).
 *
 * The ONLY module of this feature that touches disk, and only after the
 * `autospec` config block is known to exist. Reads (never executes):
 *   - .autospec/reports/design-gates.json (+ optional `.commit` sidecar),
 *   - an optional Pi-configured rules.yaml (for rule classes),
 *   - optional Constitution profile / quality-gate JSON files.
 * All reads are size-capped and regular-file-only; the report path must resolve
 * inside the repository.
 */

import { spawnSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { readYaml } from "../../lifecycle/policy.ts";
import type { GateItem } from "../../lifecycle/types.ts";
import { type AutoSpecConfig, type AutoSpecConfigResult, type AutoSpecLayer, mergeAutoSpecLayers } from "./config.ts";
import {
  type DesignGateEvidence,
  type DesignGateInput,
  type RuleCheckClass,
  designGateChecklist,
  designGateItem,
  evaluateDesignGate,
} from "./designGate.ts";
import { mapQualityLaw, qualityLawChecklist } from "./qualityLaw.ts";

const MAX_BYTES = 1_048_576;

export interface ChangedFile {
  path: string;
  renamed?: string;
  scope: "base" | "staged" | "unstaged" | "untracked";
}

export interface AutoSpecGateContext {
  cwd: string;
  headCommit: string;
  files: readonly ChangedFile[];
}

export interface AutoSpecGateEvidence {
  items: GateItem[];
  /** Lines for the finalization output. */
  checklist: string[];
  /** The evidence behind the design gate item, when the gate is configured. */
  design?: DesignGateEvidence;
}

export interface LoadOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Read both layers' `autospec` block. Nothing is read beyond the two YAML files. */
export async function loadAutoSpecConfig(cwd: string, opts: LoadOptions = {}): Promise<AutoSpecConfigResult> {
  const env = opts.env ?? process.env;
  const agentDir = opts.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? "~", ".pi", "agent");
  const read = async (path: string): Promise<AutoSpecLayer> => {
    try {
      const { raw } = await readYaml(path);
      if (raw === undefined) return {};
      if (!isPlain(raw)) return { error: `${path} is not a mapping` };
      return raw.autospec === undefined ? {} : { raw: raw.autospec };
    } catch (e) {
      return { error: `${path}: ${(e as Error).message}` };
    }
  };
  return mergeAutoSpecLayers({
    global: await read(join(agentDir, "engineering.yaml")),
    repo: await read(join(cwd, ".pi", "engineering.yaml")),
  });
}

function readSmallSync(path: string): string | undefined {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (st.size > MAX_BYTES) throw new Error(`${path} is larger than ${MAX_BYTES} bytes`);
  return readFileSync(path, "utf8");
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 8 * MAX_BYTES, timeout: 20_000 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

/** A file's content AS COMMITTED at `sha`. Untracked or modified worktree copies are never read. */
function readCommitted(cwd: string, sha: string, rel: string): string | undefined {
  const size = git(cwd, ["cat-file", "-s", `${sha}:${rel}`]);
  if (!size.ok) return undefined;
  if (Number(size.out.trim()) > MAX_BYTES) throw new Error(`${rel} is larger than ${MAX_BYTES} bytes`);
  const r = git(cwd, ["show", `${sha}:${rel}`]);
  return r.ok ? r.out : undefined;
}

function globToRegex(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; ) {
    if (pattern.startsWith("**/", i)) {
      out += "(?:[^/]+/)*";
      i += 3;
    } else if (pattern.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (pattern[i] === "*") {
      out += "[^/]*";
      i++;
    } else {
      out += pattern[i]!.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

/** Files (and rename sources) that match any ui_paths glob. */
export function uiFilesOf(files: readonly ChangedFile[], uiPaths: readonly string[]): ChangedFile[] {
  const rx = uiPaths.map(globToRegex);
  const hit = (p: string) => rx.some((r) => r.test(p.replace(/^\.\//, "")));
  return files.filter((f) => hit(f.path) || (f.renamed !== undefined && hit(f.renamed)));
}

function ruleClasses(path: string, cwd: string): Map<string, RuleCheckClass> {
  const abs = isAbsolute(path) ? path : join(cwd, path);
  const text = readSmallSync(abs);
  if (text === undefined) throw new Error(`rules_file not found: ${abs}`);
  const raw = parseYaml(text) as unknown;
  if (!isPlain(raw) || !Array.isArray(raw.rules)) throw new Error(`rules_file ${abs} has no rules list`);
  const map = new Map<string, RuleCheckClass>();
  for (const r of raw.rules) {
    if (!isPlain(r) || typeof r.id !== "string") throw new Error(`rules_file ${abs}: rule without an id`);
    // A missing or unknown `check` is never defaulted to auto (that would credit it as executed).
    if (r.check !== "auto" && r.check !== "vlm" && r.check !== "review") {
      throw new Error(`rules_file ${abs}: rule ${r.id} has check ${JSON.stringify(r.check)}; expected auto|vlm|review`);
    }
    map.set(r.id, r.check);
  }
  return map;
}

function attestationOf(
  keyFile: string | null,
  cwd: string,
  sha: string,
  sigPath: string,
  reportText: string,
  statedCommit: string | null,
): "valid" | "invalid" | "not_configured" {
  if (!keyFile) return "not_configured";
  try {
    const key = readSmallSync(isAbsolute(keyFile) ? keyFile : join(cwd, keyFile))?.trim();
    if (!key || key.length < 16) return "invalid";
    const sig = readCommitted(cwd, sha, sigPath)?.trim().toLowerCase();
    if (!sig || !/^[0-9a-f]{64}$/.test(sig) || !statedCommit) return "invalid";
    const digest = createHash("sha256").update(reportText, "utf8").digest("hex");
    const want = createHmac("sha256", key).update(`${statedCommit}\n${digest}`).digest();
    const got = Buffer.from(sig, "hex");
    return got.length === want.length && timingSafeEqual(got, want) ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

/**
 * Evaluate the design gate for the tree at `sha`. The report is read ONLY from
 * that commit: an untracked or edited worktree copy never counts. With an
 * operator attestation key configured the report must also carry a valid HMAC.
 */
function evaluateAt(
  cfg: NonNullable<AutoSpecConfig["designGate"]>,
  a: { cwd: string; sha: string; files: readonly ChangedFile[] },
): { evidence: DesignGateEvidence; note: string | null } {
  const ui = cfg.uiPaths.length ? uiFilesOf(a.files, cfg.uiPaths) : [...a.files];
  const uiTouched = ui.length > 0;
  const uiUncommitted = ui.some((f) => f.scope !== "base");
  const mk = (over: Partial<DesignGateInput>, note: string | null = null) => ({
    evidence: evaluateDesignGate({ report: undefined, headCommit: a.sha, uiTouched, uiUncommitted, ...over }),
    note,
  });
  if (!uiTouched) return mk({});
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(a.sha)) return mk({ report: null }, "no commit to bind the report to");
  try {
    const text = readCommitted(a.cwd, a.sha, cfg.reportPath);
    const classes = cfg.rulesFile ? ruleClasses(cfg.rulesFile, a.cwd) : undefined;
    if (text === undefined) {
      const loose = existsSync(join(a.cwd, cfg.reportPath));
      return mk(
        {},
        loose ? "a report exists in the worktree but is not committed; uncommitted reports are ignored" : null,
      );
    }
    let report: unknown;
    try {
      report = JSON.parse(text);
    } catch {
      report = null; // present but not JSON -> invalid, never "missing"
    }
    const sidecar = readCommitted(a.cwd, a.sha, cfg.reportPath.replace(/\.json$/, ".commit"))?.trim() || null;
    const stated = isPlain(report) && typeof report.commit_sha === "string" ? report.commit_sha : sidecar;
    const sigPath = cfg.reportPath.replace(/\.json$/, ".sig");
    const covers = (c: string): boolean => {
      if (c === a.sha) return true;
      if (!git(a.cwd, ["cat-file", "-e", `${c}^{commit}`]).ok) return false;
      if (!git(a.cwd, ["merge-base", "--is-ancestor", c, a.sha]).ok) return false;
      const diff = git(a.cwd, ["diff", "--no-renames", "--name-only", "-z", c, a.sha]);
      if (!diff.ok) return false;
      const evidenceFiles = new Set([cfg.reportPath, sigPath, cfg.reportPath.replace(/\.json$/, ".commit")]);
      const changed = diff.out
        .split("\0")
        .filter((p) => p && !evidenceFiles.has(p))
        .map((path) => ({ path, scope: "base" as const }));
      return (cfg.uiPaths.length ? uiFilesOf(changed, cfg.uiPaths) : changed).length === 0;
    };
    return mk({
      report,
      sidecarCommit: sidecar,
      commitCovers: covers,
      attestation: attestationOf(cfg.attestationKeyFile, a.cwd, a.sha, sigPath, text, stated),
      ...(classes ? { ruleClasses: classes } : {}),
    });
  } catch (e) {
    return mk({ report: null }, (e as Error).message);
  }
}

function readJson(path: string, cwd: string): unknown {
  const text = readSmallSync(isAbsolute(path) ? path : join(cwd, path));
  if (text === undefined) throw new Error(`not found: ${path}`);
  return JSON.parse(text);
}

/**
 * Reasons an orchestrated mission must NOT complete, from the design gate, for
 * the candidate commit. Synchronous so the (synchronous) CompletionGate stays
 * synchronous. Empty = nothing blocks. Fails closed: when the gate is required
 * and the evidence cannot be established, it blocks; it never silently skips.
 */
export function missionDesignGateReasons(
  result: AutoSpecConfigResult,
  a: { repoRoot: string; candidates: ReadonlyArray<{ baseSha: string; candidateSha: string }> },
): string[] {
  if (result.kind === "off") return [];
  if (result.kind === "invalid") return [`autospec_config: invalid configuration: ${result.notes.join("; ")}`];
  const cfg = result.config.designGate;
  if (!cfg?.requireForUi) return [];
  if (a.candidates.length === 0) return [];
  if (a.candidates.length > 1) {
    return ["design_gate: missions with several repository candidates are not supported by the design gate yet"];
  }
  const { baseSha, candidateSha } = a.candidates[0]!;
  const diff = git(a.repoRoot, ["diff", "--no-renames", "--name-only", "-z", baseSha, candidateSha]);
  if (!diff.ok) return ["design_gate: cannot list the candidate's changed files (git diff failed)"];
  const files = diff.out
    .split("\0")
    .filter(Boolean)
    .map((path) => ({ path, scope: "base" as const }));
  const { evidence, note } = evaluateAt(cfg, { cwd: a.repoRoot, sha: candidateSha, files });
  if (evidence.state === "passed" || evidence.state === "not_applicable") return [];
  return [`design_gate (${evidence.state}): ${evidence.reason}${note ? ` (${note})` : ""}`];
}

/**
 * Evidence for one lifecycle gate evaluation. Never throws: every failure becomes
 * a required-ness-respecting unavailable item (fail closed when required).
 */
export async function collectAutoSpecGateEvidence(
  result: AutoSpecConfigResult,
  ctx: AutoSpecGateContext,
): Promise<AutoSpecGateEvidence> {
  if (result.kind === "off") return { items: [], checklist: [] };
  if (result.kind === "invalid") {
    return {
      items: [
        {
          key: "autospec_config",
          status: "unavailable",
          required: true,
          reason: `autospec configuration is invalid: ${result.notes.join("; ")}`,
          blockers: ["autospec_config: invalid configuration"],
        },
      ],
      checklist: [`AutoSpec integration config invalid (fail closed): ${result.notes.join("; ")}`],
    };
  }
  const { config } = result;
  const items: GateItem[] = [];
  const checklist: string[] = [];
  let design: DesignGateEvidence | undefined;
  if (config.designGate) {
    const { evidence, note } = evaluateAt(config.designGate, { cwd: ctx.cwd, sha: ctx.headCommit, files: ctx.files });
    design = evidence;
    const item = designGateItem(evidence, config.designGate.requireForUi);
    if (note) item.reason = `${item.reason} (${note})`;
    items.push(item);
    checklist.push(...designGateChecklist(evidence));
  }
  if (config.qualityLaw) {
    try {
      const q = config.qualityLaw;
      const profile = q.profileFile ? readJson(q.profileFile, ctx.cwd) : undefined;
      const gates = q.gateFiles.map((f) => readJson(f, ctx.cwd));
      checklist.push(
        ...qualityLawChecklist(
          mapQualityLaw({
            ...(profile !== undefined ? { profile } : {}),
            ...(q.profileId ? { profileId: q.profileId } : {}),
            gates,
          }),
        ),
      );
    } catch (e) {
      checklist.push(`Quality law unavailable (informational): ${(e as Error).message}`);
    }
  }
  for (const n of config.notes) checklist.push(`AutoSpec config note: ${n}`);
  return { items, checklist, ...(design ? { design } : {}) };
}
