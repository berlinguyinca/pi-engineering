/**
 * Review-only model guard — a model the operator marked review-only must not
 * implement (issue #727).
 *
 * Mission work is routed by role, and roles carry `readOnly` / `independent`
 * flags (`src/lifecycle/types.ts`), so a reviewer role is read-only BY ROUTING.
 * An interactive or handoff-resumed session bypasses role routing entirely: it
 * runs on whatever the harness pinned in `/model`, and nothing reconciled that
 * pin against "is this model allowed to mutate". Observed on 2026-11-18: a
 * session pinned to a review-only Opus was handed off, resumed, implemented a
 * change, and MERGED it (#725, squash 599c06d0). Operator policy is that model
 * is for review. Nothing stopped it.
 *
 * `primaryWorktreeGuard.ts` is the precedent for the shape: a `tool_call`-hook
 * guard that blocks the session's own mutating calls and leaves read-only
 * inspection alone. Same shape here, with the model in place of the checkout:
 *
 *   - `write` / `edit` (the built-in file writers);
 *   - bash `git` commands that change repository state (`isMutatingGitCommand`,
 *     with the culprit segment named);
 *   - bash writes (`>`, `>>`, `tee`, `sed -i`, `mv`/`cp`, via `extractWriteTargets`);
 *   - `gh pr merge`, the step that actually shipped the incident and the one
 *     non-git verb this guard knows.
 *
 * Read-only tools, `git status`/`log`/`diff`/`fetch`, `git worktree` management,
 * test/build/lint commands and the review tools (`gh pr view|checks|review`)
 * stay allowed — reviewing IS the work such a model was pinned for.
 *
 * Which model? `ctx.model` of the tool_call event: pi resolves it at call time
 * (`createContext()` exposes it as a getter over the runner's `getModel()`), so
 * it is the session's CURRENT model, and a mid-session `/model` switch is seen
 * by the next call. `PI_MODEL`/`PI_PROVIDER` are the fallback, not the primary
 * signal: pi sets those on a bash CHILD's environment (`resolveSpawnContext`
 * deletes them from a copy of `process.env` and re-adds them from `ctx.model`),
 * so the pi process's own `process.env` carries them only when it inherited
 * them from whatever launched it — which for a pane started from another pi
 * session means the PARENT's model. Reading them is therefore a fallback for
 * processes the runtime spawns with them, and a block reason always names the
 * model it judged so an inherited value is visible to the operator.
 *
 * Opt-in and reversible: `engineering.yaml` `models.review_only` defaults to
 * empty, which makes the guard inert. `PI_ENG_REVIEW_ONLY_MODELS` overrides the
 * file; `PI_ENG_REVIEW_ONLY_GUARD=0` turns the guard off (mirroring
 * `PI_ENG_WORKTREE_GUARD=0`). Matching is on `provider/id`, or on a bare `id`
 * which matches any provider; ids are compared as written.
 *
 * The bash checks are best-effort (no full shell parsing), exactly as in the
 * primary worktree guard: an unrecognized mutating form is a gap to close when
 * it bites, not a contract hole.
 */
import { join } from "node:path";
import { readYaml } from "../lifecycle/policy.ts";
import {
  atCommandPosition,
  extractWriteTargets,
  mutatingGitSegment,
  segments,
  tokenize,
} from "./primaryWorktreeGuard.ts";

/** A model as the session names it. `provider` is absent when nothing stated one. */
export interface ModelRef {
  provider?: string;
  id: string;
}

export interface ReviewOnlyModelGuardConfig {
  enabled: boolean;
  /** Review-only models: `provider/id`, or a bare `id` that matches any provider. */
  reviewOnly: string[];
}

/** A guard verdict: block, with the reason the model and the operator see. */
export interface ReviewOnlyVerdict {
  block: true;
  reason: string;
}

const OFF = /^(0|false|off|no)$/i;

/**
 * A model id as an operator writes it: `id`, or `provider/id`. Anything else —
 * a space, a shell metacharacter, a leading `-` — is not an id, and accepting
 * it would put operator-supplied text into a comparison this guard decides on.
 */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/;

function parseList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

/**
 * Effective configuration: the env override wins over the `engineering.yaml`
 * list, and the kill switch wins over both.
 */
export function resolveReviewOnlyModelGuardConfig(
  env: NodeJS.ProcessEnv = process.env,
  yamlModels: readonly string[] = [],
): ReviewOnlyModelGuardConfig {
  const fromEnv = parseList(env.PI_ENG_REVIEW_ONLY_MODELS);
  const reviewOnly = fromEnv.length > 0 ? fromEnv : [...new Set(yamlModels.map((m) => m.trim()).filter((m) => m))];
  return { enabled: !OFF.test(env.PI_ENG_REVIEW_ONLY_GUARD ?? ""), reviewOnly };
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The keys of the top-level `models:` block this loader owns. */
const KEYS = new Set(["review_only"]);

/**
 * Parse the top-level `models:` block of `engineering.yaml`.
 *
 * The failure style is `src/github/settings.ts`'s: anything malformed or
 * unknown turns THE LAYER OFF with a note rather than being partly applied — a
 * half-read review-only list would silently un-guard the models the operator
 * meant to guard, which is the incident this file exists to stop.
 */
export function parseReviewOnlyBlock(raw: unknown): { reviewOnly: string[]; notes: string[] } {
  if (raw === undefined || raw === null) return { reviewOnly: [], notes: [] };
  const off = (note: string) => ({ reviewOnly: [], notes: [`models off: ${note}`] });
  if (!isPlain(raw)) return off("`models` must be a mapping");
  const unknown = Object.keys(raw).filter((k) => !KEYS.has(k));
  if (unknown.length > 0) return off(`unknown keys ${unknown.join(", ")}`);
  const list = raw.review_only;
  if (list === undefined || list === null) return { reviewOnly: [], notes: [] };
  if (!Array.isArray(list)) return off("`models.review_only` must be a list of model ids");
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || !MODEL_ID.test(entry.trim())) {
      return off("`models.review_only` must be a list of `provider/id` or bare `id` model ids");
    }
    const id = entry.trim();
    if (!out.includes(id)) out.push(id);
  }
  return { reviewOnly: out, notes: [] };
}

/**
 * Read `models.review_only` from `<agentDir>/engineering.yaml` and resolve it
 * with the environment. Never throws: an unreadable file is the guard off plus
 * a note (the operator wrote something, so say so rather than crash a session).
 */
export async function loadReviewOnlyModelConfig(
  agentDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ config: ReviewOnlyModelGuardConfig; notes: string[] }> {
  try {
    const { raw } = await readYaml(join(agentDir, "engineering.yaml"));
    const { reviewOnly, notes } = parseReviewOnlyBlock(isPlain(raw) ? raw.models : undefined);
    return { config: resolveReviewOnlyModelGuardConfig(env, reviewOnly), notes };
  } catch (err) {
    return {
      config: resolveReviewOnlyModelGuardConfig(env, []),
      notes: [`models off: engineering.yaml unreadable (${(err as Error).message})`],
    };
  }
}

/** Split a `provider/id` model reference the way the config and the harness write it. */
function normalize(model: ModelRef): { provider?: string; id: string } {
  const id = model.id.trim();
  if (model.provider) return { provider: model.provider.trim() || undefined, id };
  const slash = id.indexOf("/");
  if (slash > 0) return { provider: id.slice(0, slash), id: id.slice(slash + 1) };
  return { id };
}

/**
 * True when `model` is one of the review-only entries. `provider/id` matches
 * that provider and that id; a bare `id` matches the id behind any provider.
 * Ids compare as written (`Qwen3.8` is not `qwen3.8`), and a model whose
 * provider nobody stated never matches a provider-qualified entry — without
 * proof of WHICH model this is, the guard does not block. A match is proof a
 * model exists, so the return narrows.
 */
export function isReviewOnlyModel(model: ModelRef | undefined, reviewOnly: readonly string[]): model is ModelRef {
  if (!model || model.id.trim() === "") return false;
  const { provider, id } = normalize(model);
  return reviewOnly.some((entry) => {
    const slash = entry.indexOf("/");
    if (slash === -1) return entry === id;
    return provider !== undefined && entry.slice(0, slash) === provider && entry.slice(slash + 1) === id;
  });
}

/**
 * The model from the environment: `PI_PROVIDER` + `PI_MODEL`, with `PI_MODEL`
 * accepted in `provider/id` form. Undefined when nothing names a model (or only
 * a provider does) — no signal, no control effect.
 */
export function activeModelFromEnv(env: NodeJS.ProcessEnv = process.env): ModelRef | undefined {
  const id = (env.PI_MODEL ?? "").trim();
  if (!id) return undefined;
  const provider = (env.PI_PROVIDER ?? "").trim();
  return provider ? { provider, id } : normalize({ id });
}

/**
 * The `gh pr merge` segment of a command, or null.
 *
 * Merging is the step that shipped the incident, and it is not a `git` verb, so
 * this guard names it explicitly. Like the git detection it reads WORDS at
 * command positions: `echo "then gh pr merge --squash"` and
 * `grep 'gh pr merge' docs/` are prose about a command, not a merge, and
 * blocking them would block the very thing the block message tells the model to
 * do. `gh pr view|checks|review` stay allowed — reviewing is the job a
 * review-only model was pinned for.
 */
export function mergeCommandSegment(command: string): string | null {
  for (const segment of segments(command)) {
    const tokens = tokenize(segment);
    for (let i = 0; i < tokens.length; i++) {
      const word = tokens[i]!;
      if (word !== "gh" && !/(^|\/)gh$/.test(word)) continue;
      if (!atCommandPosition(tokens, i)) continue;
      const rest = tokens.slice(i + 1);
      const pr = rest.findIndex((t) => t === "pr" || t === "pull");
      if (pr !== -1 && rest.slice(pr + 1).some((t) => t === "merge")) return segment;
    }
  }
  return null;
}

/** What about this command mutates: the kind and the segment (or path) that shows it. */
interface MutatingCall {
  /** `git`, `merge`, or `write`. */
  kind: "git" | "merge" | "write";
  /** The compound-command segment, or the path the tool writes. */
  what: string;
  /** The git verb, when `kind` is git. */
  verb?: string;
}

function mutatingBashCall(command: string, env: NodeJS.ProcessEnv): MutatingCall | null {
  const git = mutatingGitSegment(command);
  if (git) return { kind: "git", what: git.segment, verb: git.verb };
  const merge = mergeCommandSegment(command);
  if (merge) return { kind: "merge", what: merge };
  const [target] = extractWriteTargets(command, env);
  return target ? { kind: "write", what: target } : null;
}

function blockReason(model: string, config: ReviewOnlyModelGuardConfig, call: MutatingCall): string {
  const lines = [
    `Blocked: model ${model} is review-only (models.review_only), and this tool call would change code or repository state.`,
    "A review-only model reviews: it reads the change, runs tests/CI, and records findings. It does not implement, commit or merge.",
    `Switch models with /model (or remove ${model} from models.review_only / PI_ENG_REVIEW_ONLY_MODELS), then re-run this call.`,
    "Read-only inspection (`read`, `git status`/`log`/`diff`/`fetch`), test/build/lint commands, `git worktree` management and the review tools stay allowed.",
  ];
  if (call.kind === "git") {
    lines.push(`Culprit segment: \`${call.what}\` (\`git ${call.verb}\` changes repository state).`);
  } else if (call.kind === "merge") {
    lines.push(`Culprit segment: \`${call.what}\` (\`gh pr merge\` lands the change).`);
  } else {
    lines.push(`Culprit: this call writes \`${call.what}\`.`);
  }
  if (config.enabled) {
    lines.push("If this session must implement on a review-only model, start it with PI_ENG_REVIEW_ONLY_GUARD=0.");
  }
  return lines.join("\n");
}

/** How to name the judged model in a reason: `provider/id`, or the bare id. */
function modelName(model: ModelRef): string {
  const { provider, id } = normalize(model);
  return provider ? `${provider}/${id}` : id;
}

export interface ReviewOnlyModelGuardOptions {
  /** The environment `PI_MODEL`/`PI_PROVIDER` are read from (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

export class ReviewOnlyModelGuard {
  private readonly config: ReviewOnlyModelGuardConfig | (() => ReviewOnlyModelGuardConfig);
  private readonly options: ReviewOnlyModelGuardOptions;

  /**
   * `config` may be a getter, so a caller can register the guard synchronously
   * and let an asynchronous `engineering.yaml` read land afterwards: the guard
   * is inert until the list exists, and armed the moment it does.
   */
  constructor(config: ReviewOnlyModelGuardConfig | (() => ReviewOnlyModelGuardConfig), options = {}) {
    this.config = config;
    this.options = options;
  }

  private currentConfig(): ReviewOnlyModelGuardConfig {
    return typeof this.config === "function" ? this.config() : this.config;
  }

  private env(): NodeJS.ProcessEnv {
    return this.options.env ?? process.env;
  }

  /**
   * Inspect a tool call before it runs. `model` is the session's live model
   * when the hook has one (pi's `ctx.model`); otherwise the environment is the
   * fallback. Returns a block verdict, or undefined to let the call run.
   */
  onToolCall(toolName: string, input: unknown, model?: ModelRef): ReviewOnlyVerdict | undefined {
    const config = this.currentConfig();
    if (!config.enabled || config.reviewOnly.length === 0) return undefined;
    const judged = model ?? activeModelFromEnv(this.env());
    if (!isReviewOnlyModel(judged, config.reviewOnly)) return undefined;

    const args = (input ?? {}) as Record<string, unknown>;
    let call: MutatingCall | null = null;
    if (toolName === "bash") {
      const command = typeof args.command === "string" ? args.command : undefined;
      if (command === undefined) return undefined;
      call = mutatingBashCall(command, this.env());
    } else if (toolName === "write" || toolName === "edit") {
      // Only the built-in file writers mutate the worktree; the read-only tools
      // that also take a `path` (read, symbol, …) are the reviewer's work.
      const path = typeof args.path === "string" ? args.path : undefined;
      if (path === undefined) return undefined;
      call = { kind: "write", what: path };
    }
    if (!call) return undefined;
    return { block: true, reason: blockReason(modelName(judged), config, call) };
  }
}

/** The slice of the extension API this guard needs: one `tool_call` hook. */
export interface ReviewOnlyModelGuardHost {
  on(
    event: "tool_call",
    handler: (
      event: { toolName: string; input: unknown },
      ctx?: { model?: { provider?: string; id: string } },
    ) => Promise<ReviewOnlyVerdict | undefined>,
  ): unknown;
}

/**
 * Attach one review-only-model guard to a live session's `tool_call` hook.
 *
 * The model is read from the event's context, which pi builds per event with
 * `model` as a live getter. Reading it is wrapped: dereferencing a context the
 * session no longer owns raises (`assertActive` in pi's runner), and a throw
 * out of a hook would take the process down — so an unreadable context falls
 * back to the environment instead.
 */
export function registerReviewOnlyModelGuard(
  pi: ReviewOnlyModelGuardHost,
  config: ReviewOnlyModelGuardConfig | (() => ReviewOnlyModelGuardConfig),
  options: ReviewOnlyModelGuardOptions = {},
): ReviewOnlyModelGuard {
  const reviewOnlyGuard = new ReviewOnlyModelGuard(config, options);
  pi.on("tool_call", async (event, ctx) => {
    let model: ModelRef | undefined;
    try {
      const live = ctx?.model;
      if (live?.id) model = { provider: live.provider, id: String(live.id) };
    } catch {
      // A context that is no longer active: judge what the environment says.
      model = undefined;
    }
    return reviewOnlyGuard.onToolCall(String(event.toolName), event.input, model);
  });
  return reviewOnlyGuard;
}
