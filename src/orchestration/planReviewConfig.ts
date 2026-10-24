/**
 * `plan_review` block of the engineering YAML layers (T03).
 *
 *   ~/.pi/agent/engineering.yaml   global/user layer: may set EVERYTHING
 *   <repo>/.pi/engineering.yaml    repo layer: may only make the gate STRICTER
 *
 *   plan_review:
 *     enabled: true                       # boolean; global layer only can turn it off
 *     max_revisions: 3
 *     modes: {low: skip, medium: offer, high: require, critical: require}
 *     override: {mode: skip, reason: "why", operator: "name"}   # global only; recorded in the ledger
 *     plannotator:                        # global only (these choose what Pi executes)
 *       command: herdr-plannotator        # bare name (looked up on /usr/local/bin:/usr/bin:/bin) or absolute path
 *       args: ["--control-plane", "https://..."]
 *       cwd: /path/to/workspace
 *       timeout_ms: 600000
 *       env_allow: [EXTRA_VAR_NAME]
 *       require_digest_echo: true         # default true: an approval must echo the plan digest
 *
 * Rules:
 *  - ANY present `plan_review` key is intent to enable. Absent in every layer = OFF.
 *  - A repo layer can raise a mode, never lower it; it cannot disable the gate,
 *    set an override, or choose the executable/args/cwd/env: those are ignored
 *    with a warning.
 *  - Anything malformed (including a type typo such as `enabled: "true"`, a
 *    non-mapping block, or an unreadable global file) FAILS CLOSED: every risk is
 *    `require` with no reviewer. The reason is returned in `configNotes` and shown
 *    in the blocking finding. Errors are never swallowed into OFF.
 */

import { join } from "node:path";
import { readYaml } from "../lifecycle/policy.ts";
import { assertTrustedCommand, createHerdrPlannotatorTransport } from "../platform/HerdrPlannotatorTransport.ts";
import { FilePendingPlanStore, PlannotatorAdapter } from "../platform/Plannotator.ts";
import { resolveStateRoot } from "../runtime/isolation/stateDir.ts";
import {
  DEFAULT_PLAN_REVIEW_MODES,
  PLAN_REVIEW_MODES,
  type PlanReviewMode,
  type PlanReviewPolicyConfig,
} from "./planRecords.ts";
import type { PlanGateInput } from "./planReview.ts";

export type PlanReviewSettings = Pick<PlanGateInput, "adapter" | "policy" | "maxRevisions"> & {
  /** Warnings and errors from reading the layers, to show wherever the gate reports. */
  configNotes: string[];
};

/** One YAML layer's `plan_review` value; `error` means the layer could not be read/parsed. */
export interface PlanReviewLayer {
  raw?: unknown;
  error?: string;
}

const RISKS = ["low", "medium", "high", "critical"] as const;
type Risk = (typeof RISKS)[number];
type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => !!v && typeof v === "object" && !Array.isArray(v);
const RANK: Record<PlanReviewMode, number> = { skip: 0, offer: 1, require: 2 };
const DEFAULT_MAX_REVISIONS = 3;

class ConfigError extends Error {}

const mode = (v: unknown, where: string): PlanReviewMode => {
  if (typeof v === "string" && PLAN_REVIEW_MODES.includes(v as PlanReviewMode)) return v as PlanReviewMode;
  throw new ConfigError(`${where} must be one of ${PLAN_REVIEW_MODES.join("|")}`);
};

interface Block {
  enabled: boolean | undefined;
  modes: Partial<Record<Risk, PlanReviewMode>>;
  override?: NonNullable<PlanReviewPolicyConfig["override"]>;
  maxRevisions?: number;
  plannotator: Plain | undefined;
  /** Keys present that this layer is not allowed to use. */
  forbidden: string[];
  /** Present keys other than a bare `enabled: false`. */
  hasIntent: boolean;
}

function parseBlock(raw: unknown, where: string): Block {
  if (!isPlain(raw)) throw new ConfigError(`${where}: plan_review must be a mapping, got ${JSON.stringify(raw)}`);
  const known = ["enabled", "modes", "override", "max_revisions", "plannotator"];
  for (const k of Object.keys(raw)) if (!known.includes(k)) throw new ConfigError(`${where}: unknown plan_review.${k}`);
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new ConfigError(
      `${where}: plan_review.enabled must be true or false (a YAML boolean), got ${JSON.stringify(raw.enabled)}`,
    );
  }
  const modes: Block["modes"] = {};
  if (raw.modes !== undefined) {
    if (!isPlain(raw.modes)) throw new ConfigError(`${where}: plan_review.modes must be a mapping`);
    for (const [k, v] of Object.entries(raw.modes)) {
      if (!(RISKS as readonly string[]).includes(k))
        throw new ConfigError(`${where}: plan_review.modes.${k} is not a risk class`);
      modes[k as Risk] = mode(v, `${where}: plan_review.modes.${k}`);
    }
  }
  let override: Block["override"];
  if (raw.override !== undefined) {
    const o = raw.override;
    if (!isPlain(o)) throw new ConfigError(`${where}: plan_review.override must be a mapping`);
    if (typeof o.reason !== "string" || !o.reason.trim())
      throw new ConfigError(`${where}: plan_review.override.reason is required`);
    override = {
      mode: mode(o.mode, `${where}: plan_review.override.mode`),
      reason: o.reason,
      ...(typeof o.operator === "string" ? { operator: o.operator } : {}),
    };
  }
  let maxRevisions: number | undefined;
  if (raw.max_revisions !== undefined) {
    const n = raw.max_revisions;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 20) {
      throw new ConfigError(`${where}: plan_review.max_revisions must be an integer 1..20`);
    }
    maxRevisions = n;
  }
  if (raw.plannotator !== undefined && !isPlain(raw.plannotator)) {
    throw new ConfigError(`${where}: plan_review.plannotator must be a mapping`);
  }
  const forbidden = ["override", "plannotator"].filter((k) => raw[k] !== undefined);
  const keys = Object.keys(raw).filter((k) => !(k === "enabled" && raw.enabled === false));
  return {
    enabled: raw.enabled as boolean | undefined,
    modes,
    ...(override ? { override } : {}),
    ...(maxRevisions ? { maxRevisions } : {}),
    plannotator: raw.plannotator as Plain | undefined,
    forbidden,
    hasIntent: keys.length > 0,
  };
}

function failClosed(notes: string[]): PlanReviewSettings {
  return {
    adapter: null,
    policy: { modes: { low: "require", medium: "require", high: "require", critical: "require" } },
    configNotes: notes,
  };
}

function buildAdapter(p: Plain | undefined, stateDir: string): PlannotatorAdapter {
  const cfg = p ?? {};
  if (cfg.command !== undefined && (typeof cfg.command !== "string" || !cfg.command)) {
    throw new ConfigError("global: plan_review.plannotator.command must be a string");
  }
  if (typeof cfg.command === "string") {
    try {
      assertTrustedCommand(cfg.command);
    } catch (e) {
      throw new ConfigError(`global: ${(e as Error).message}`);
    }
  }
  if (cfg.args !== undefined && (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== "string"))) {
    throw new ConfigError("global: plan_review.plannotator.args must be a list of strings");
  }
  if (cfg.cwd !== undefined && typeof cfg.cwd !== "string")
    throw new ConfigError("global: plan_review.plannotator.cwd must be a string");
  if (
    cfg.env_allow !== undefined &&
    (!Array.isArray(cfg.env_allow) ||
      cfg.env_allow.some((a) => typeof a !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)))
  ) {
    throw new ConfigError("global: plan_review.plannotator.env_allow must be a list of variable names");
  }
  if (cfg.require_digest_echo !== undefined && typeof cfg.require_digest_echo !== "boolean") {
    throw new ConfigError("global: plan_review.plannotator.require_digest_echo must be true or false");
  }
  if (
    cfg.timeout_ms !== undefined &&
    (typeof cfg.timeout_ms !== "number" || cfg.timeout_ms < 1000 || cfg.timeout_ms > 86_400_000)
  ) {
    throw new ConfigError("global: plan_review.plannotator.timeout_ms must be 1000..86400000");
  }
  const timeoutMs = typeof cfg.timeout_ms === "number" ? cfg.timeout_ms : undefined;
  return new PlannotatorAdapter({
    transport: createHerdrPlannotatorTransport({
      ...(typeof cfg.command === "string" ? { command: cfg.command } : {}),
      ...(Array.isArray(cfg.args) ? { args: cfg.args as string[] } : {}),
      ...(typeof cfg.cwd === "string" ? { cwd: cfg.cwd } : {}),
      ...(Array.isArray(cfg.env_allow) ? { envAllow: cfg.env_allow as string[] } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    }),
    requireDigestEcho: cfg.require_digest_echo !== false,
    store: new FilePendingPlanStore(join(stateDir, "plan-review", "pending-plans.jsonl")),
    decisionTimeoutMs: (timeoutMs ?? 10 * 60_000) + 5_000,
  });
}

/** Pure merge of the two layers. Exported for tests. */
export function mergePlanReviewLayers(
  layers: { global: PlanReviewLayer; repo: PlanReviewLayer },
  stateDir: string,
): PlanReviewSettings | null {
  const notes: string[] = [];
  const errors: string[] = [];
  let g: Block | undefined;
  let r: Block | undefined;

  if (layers.global.error) errors.push(`global config unreadable: ${layers.global.error}`);
  else if (layers.global.raw !== undefined) {
    try {
      g = parseBlock(layers.global.raw, "global");
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  if (layers.repo.error) {
    notes.push(`repo config unreadable, plan_review from it ignored: ${layers.repo.error}`);
  } else if (layers.repo.raw !== undefined) {
    try {
      r = parseBlock(layers.repo.raw, "repo");
    } catch (e) {
      // A malformed repo block cannot weaken anything, but a typo is still a signal to enable.
      errors.push((e as Error).message);
    }
  }
  if (r) {
    if (r.enabled === false) notes.push("repo plan_review.enabled: false ignored (a repo cannot disable plan review)");
    for (const k of r.forbidden) notes.push(`repo plan_review.${k} ignored (only the global/user config may set it)`);
  }

  const globalPresent = layers.global.raw !== undefined || !!layers.global.error;
  const repoIntent = !!r?.hasIntent || (layers.repo.raw !== undefined && !r && !layers.repo.error);
  if (errors.length === 0 && !globalPresent && !repoIntent) return null;
  if (errors.length > 0) return failClosed([...errors, ...notes]);
  if (g?.enabled === false && !repoIntent) return null;

  const gModes = g?.enabled === false ? {} : (g?.modes ?? {});
  const modes: Partial<Record<Risk, PlanReviewMode>> = {};
  for (const risk of RISKS) {
    const base = gModes[risk] ?? DEFAULT_PLAN_REVIEW_MODES[risk];
    const asked = r?.modes[risk];
    modes[risk] = asked && RANK[asked] > RANK[base] ? asked : base;
    if (asked && RANK[asked] < RANK[base])
      notes.push(`repo plan_review.modes.${risk}: ${asked} ignored (cannot lower ${base})`);
  }
  const maxRevisions = Math.min(g?.maxRevisions ?? DEFAULT_MAX_REVISIONS, r?.maxRevisions ?? Number.MAX_SAFE_INTEGER);
  try {
    const adapter = buildAdapter(g?.plannotator, stateDir);
    return {
      adapter,
      policy: { modes, ...(g?.override && g.enabled !== false ? { override: g.override } : {}) },
      maxRevisions,
      configNotes: notes,
    };
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    return failClosed([e.message, ...notes]);
  }
}

export interface LoadPlanReviewOptions {
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}

/** Read both layers and merge. Read/parse problems fail closed or surface as notes; none become OFF silently. */
export async function loadPlanReviewSettings(
  cwd: string,
  opts: LoadPlanReviewOptions | string = {},
): Promise<PlanReviewSettings | null> {
  const o: LoadPlanReviewOptions = typeof opts === "string" ? { agentDir: opts } : opts;
  const env = o.env ?? process.env;
  const agentDir = o.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? "~", ".pi", "agent");
  const read = async (path: string): Promise<PlanReviewLayer> => {
    try {
      const { raw } = await readYaml(path);
      return isPlain(raw)
        ? raw.plan_review === undefined
          ? {}
          : { raw: raw.plan_review }
        : raw === undefined
          ? {}
          : { error: `${path} is not a mapping` };
    } catch (e) {
      return { error: `${path}: ${(e as Error).message}` };
    }
  };
  return mergePlanReviewLayers(
    { global: await read(join(agentDir, "engineering.yaml")), repo: await read(join(cwd, ".pi", "engineering.yaml")) },
    o.stateDir ?? resolveStateRoot(env),
  );
}
