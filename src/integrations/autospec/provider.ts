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

import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, sep } from "node:path";
import { readYaml } from "../../lifecycle/policy.ts";
import type { GateItem } from "../../lifecycle/types.ts";
import { type AutoSpecConfig, type AutoSpecConfigResult, type AutoSpecLayer, mergeAutoSpecLayers } from "./config.ts";
import {
  type DesignGateEvidence,
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

async function readSmall(path: string): Promise<string | undefined> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (!st.isFile()) throw new Error(`${path} is not a regular file`);
  if (st.size > MAX_BYTES) throw new Error(`${path} is larger than ${MAX_BYTES} bytes`);
  return readFile(path, "utf8");
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

async function ruleClasses(path: string, cwd: string): Promise<Map<string, RuleCheckClass>> {
  const abs = isAbsolute(path) ? path : join(cwd, path);
  const text = await readSmall(abs);
  const map = new Map<string, RuleCheckClass>();
  if (text === undefined) throw new Error(`rules_file not found: ${abs}`);
  const { raw } = await readYaml(abs);
  if (!isPlain(raw) || !Array.isArray(raw.rules)) throw new Error(`rules_file ${abs} has no rules list`);
  for (const r of raw.rules) {
    if (!isPlain(r) || typeof r.id !== "string") continue;
    map.set(r.id, r.check === "vlm" || r.check === "review" ? r.check : "auto");
  }
  return map;
}

async function designGate(cfg: NonNullable<AutoSpecConfig["designGate"]>, ctx: AutoSpecGateContext) {
  // With no ui_paths Pi cannot tell what is UI: every change is treated as UI-touching.
  const ui = cfg.uiPaths.length ? uiFilesOf(ctx.files, cfg.uiPaths) : [...ctx.files];
  const uiTouched = ui.length > 0;
  const uiUncommitted = ui.some((f) => f.scope !== "base");
  let report: unknown;
  let sidecarCommit: string | null = null;
  let classes: Map<string, RuleCheckClass> | undefined;
  if (uiTouched) {
    try {
      const root = await realpath(ctx.cwd);
      const abs = join(root, cfg.reportPath);
      const text = await readSmall(abs);
      if (text !== undefined) {
        const real = await realpath(abs);
        if (!real.startsWith(root + sep)) throw new Error("report resolves outside the repository");
        try {
          report = JSON.parse(text);
        } catch {
          report = null; // present but not JSON -> invalid, never "missing"
        }
        const side = await readSmall(abs.replace(/\.json$/, ".commit"));
        sidecarCommit = side?.trim() || null;
      }
      if (cfg.rulesFile) classes = await ruleClasses(cfg.rulesFile, ctx.cwd);
    } catch (e) {
      return {
        evidence: evaluateDesignGate({ report: null, headCommit: ctx.headCommit, uiTouched, uiUncommitted }),
        note: (e as Error).message,
      };
    }
  }
  return {
    evidence: evaluateDesignGate({
      report,
      sidecarCommit,
      headCommit: ctx.headCommit,
      uiTouched,
      uiUncommitted,
      ...(classes ? { ruleClasses: classes } : {}),
    }),
    note: null as string | null,
  };
}

async function readJson(path: string, cwd: string): Promise<unknown> {
  const text = await readSmall(isAbsolute(path) ? path : join(cwd, path));
  if (text === undefined) throw new Error(`not found: ${path}`);
  return JSON.parse(text);
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
    const { evidence, note } = await designGate(config.designGate, ctx);
    design = evidence;
    const item = designGateItem(evidence, config.designGate.requireForUi);
    if (note) item.reason = `${item.reason} (${note})`;
    items.push(item);
    checklist.push(...designGateChecklist(evidence));
  }
  if (config.qualityLaw) {
    try {
      const q = config.qualityLaw;
      const profile = q.profileFile ? await readJson(q.profileFile, ctx.cwd) : undefined;
      const gates = await Promise.all(q.gateFiles.map((f) => readJson(f, ctx.cwd)));
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
