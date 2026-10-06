/**
 * Task-contract schema validation and DAG helpers (spec §3, §4).
 *
 * The planner's output is untrusted model text. Everything it produces passes
 * through `parsePlannerOutput`, which rejects contracts that would make the
 * worker's job unbounded or the plan unexecutable: unsafe or repository-wide
 * write scopes, missing objectives/acceptance, self or unknown dependencies,
 * duplicate ids and dependency cycles.
 */

import { parse as parseYaml } from "yaml";
import { scopesOverlap } from "../plan/taskDag.ts";
import type { ContractRisk, ContractScope, PlannerOutput, TaskContract } from "./types.ts";

export const CONTRACT_LIMITS = {
  max_contracts: 24,
  max_list: 20,
  max_text: 2000,
} as const;

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RISKS: readonly ContractRisk[] = ["low", "medium", "high"];

export type ContractParse = { ok: true; contract: TaskContract } | { ok: false; errors: string[] };
export type PlanParse = { ok: true; plan: PlannerOutput } | { ok: false; errors: string[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(v: unknown, field: string, errors: string[], opts: { required?: boolean } = {}): string[] {
  if (v === undefined || v === null) {
    if (opts.required) errors.push(`${field} is required`);
    return [];
  }
  const arr = Array.isArray(v) ? v : [v];
  const out: string[] = [];
  for (const item of arr) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") {
      errors.push(`${field} entries must be strings`);
      continue;
    }
    const s = String(item).trim();
    if (!s) continue;
    if (s.length > CONTRACT_LIMITS.max_text) errors.push(`${field} entry exceeds ${CONTRACT_LIMITS.max_text} chars`);
    out.push(s);
  }
  if (out.length > CONTRACT_LIMITS.max_list) errors.push(`${field} has more than ${CONTRACT_LIMITS.max_list} entries`);
  if (opts.required && out.length === 0) errors.push(`${field} must not be empty`);
  return out;
}

/** Why a scope glob is unacceptable, or null when it is a bounded relative glob. */
export function scopeGlobError(glob: string): string | null {
  if (!glob) return "empty scope glob";
  if (/\s/.test(glob)) return `scope glob "${glob}" contains whitespace`;
  if (glob.includes("\\")) return `scope glob "${glob}" must use forward slashes`;
  if (glob.startsWith("/") || /^[A-Za-z]:/.test(glob)) return `scope glob "${glob}" must be repository-relative`;
  const segments = glob.split("/");
  if (segments.some((s) => s === "..")) return `scope glob "${glob}" escapes the repository`;
  const first = segments[0] ?? "";
  if (first === "" || first === "." || /[*?[\]{}]/.test(first)) {
    return `scope glob "${glob}" is unbounded (its first path segment must be literal)`;
  }
  return null;
}

/** Validate one raw contract object from planner output. */
export function parseTaskContract(raw: unknown): ContractParse {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["contract must be an object"] };
  const id = typeof raw.task_id === "string" ? raw.task_id.trim() : typeof raw.id === "string" ? raw.id.trim() : "";
  if (!TASK_ID.test(id)) errors.push(`task_id "${id}" must match ${TASK_ID}`);
  const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
  if (!objective) errors.push(`${id || "contract"}: objective is required`);
  if (objective.length > CONTRACT_LIMITS.max_text) errors.push(`${id}: objective is too long`);

  const depends_on = stringList(raw.depends_on, `${id}.depends_on`, errors);
  if (depends_on.includes(id)) errors.push(`${id} depends on itself`);
  if (new Set(depends_on).size !== depends_on.length) errors.push(`${id}.depends_on has duplicates`);

  const rawScope = raw.scope;
  const allowedRaw = isRecord(rawScope) ? rawScope.allowed : rawScope;
  const forbiddenRaw = isRecord(rawScope) ? rawScope.forbidden : undefined;
  const allowed = stringList(allowedRaw, `${id}.scope.allowed`, errors, { required: true });
  const forbidden = stringList(forbiddenRaw, `${id}.scope.forbidden`, errors);
  for (const glob of [...allowed, ...forbidden]) {
    const why = scopeGlobError(glob);
    if (why) errors.push(`${id}: ${why}`);
  }

  const acceptance = stringList(raw.acceptance, `${id}.acceptance`, errors, { required: true });
  const verification = stringList(raw.verification, `${id}.verification`, errors);
  const constraints = stringList(raw.constraints, `${id}.constraints`, errors);
  const relevant_files = stringList(raw.relevant_files, `${id}.relevant_files`, errors);
  const decisions = stringList(raw.decisions, `${id}.decisions`, errors);
  let risk: ContractRisk = "medium";
  if (raw.risk !== undefined) {
    if (typeof raw.risk === "string" && (RISKS as readonly string[]).includes(raw.risk))
      risk = raw.risk as ContractRisk;
    else errors.push(`${id}.risk must be one of ${RISKS.join("|")}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    contract: {
      task_id: id,
      objective,
      depends_on,
      scope: { allowed, forbidden },
      acceptance,
      verification,
      constraints,
      risk,
      relevant_files,
      decisions,
    },
  };
}

/** Find one dependency cycle (as a path a -> b -> ... -> a), or null. */
function findCycle(contracts: TaskContract[]): string[] | null {
  const deps = new Map(contracts.map((c) => [c.task_id, c.depends_on]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    const s = state.get(id);
    if (s === "done") return null;
    if (s === "visiting") return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, "visiting");
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      if (!deps.has(d)) continue;
      const cycle = visit(d);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const c of contracts) {
    const cycle = visit(c.task_id);
    if (cycle) return cycle;
  }
  return null;
}

/** Validate the contract set as an executable DAG. */
export function validateContractDag(
  contracts: TaskContract[],
  opts: { external?: ReadonlySet<string> } = {},
): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  if (contracts.length === 0) errors.push("plan has no contracts");
  if (contracts.length > CONTRACT_LIMITS.max_contracts) {
    errors.push(`plan has ${contracts.length} contracts (max ${CONTRACT_LIMITS.max_contracts})`);
  }
  const ids = new Set<string>();
  for (const c of contracts) {
    if (ids.has(c.task_id)) errors.push(`duplicate task_id ${c.task_id}`);
    ids.add(c.task_id);
  }
  for (const c of contracts) {
    for (const d of c.depends_on) {
      if (!ids.has(d) && !opts.external?.has(d)) errors.push(`${c.task_id} depends on unknown task ${d}`);
    }
  }
  const cycle = findCycle(contracts);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
  return { ok: errors.length === 0, errors };
}

/** Group contracts into dependency layers; each layer may run concurrently. */
export function dagLayers(contracts: TaskContract[]): TaskContract[][] {
  const remaining = new Map(contracts.map((c) => [c.task_id, c]));
  const done = new Set<string>();
  const layers: TaskContract[][] = [];
  // Dependencies outside the set (already passed before a replan) are satisfied.
  const satisfied = (d: string) => done.has(d) || !contracts.some((x) => x.task_id === d);
  while (remaining.size > 0) {
    const layer = [...remaining.values()].filter((c) => c.depends_on.every(satisfied));
    if (layer.length === 0) throw new Error("dependency cycle");
    for (const c of layer) remaining.delete(c.task_id);
    for (const c of layer) done.add(c.task_id);
    layers.push(layer);
  }
  return layers;
}

/** Contracts not yet passed whose dependencies have all passed. */
export function readyContracts(contracts: TaskContract[], passed: ReadonlySet<string>): TaskContract[] {
  return contracts.filter((c) => !passed.has(c.task_id) && c.depends_on.every((d) => passed.has(d)));
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        const slash = glob[i + 2] === "/";
        re += slash ? "(?:.*/)?" : ".*";
        i += slash ? 2 : 1;
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // A literal directory scope covers everything below it.
  return new RegExp(`^${re}(?:/.*)?$`);
}

export function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob.replace(/\/$/, "")).test(path.replace(/^\.\//, ""));
}

/** True when `path` is writable under `scope`. */
export function matchesScope(path: string, scope: ContractScope): boolean {
  if (scope.forbidden.some((g) => matchesGlob(path, g))) return false;
  return scope.allowed.some((g) => matchesGlob(path, g));
}

/** Literal prefix of a glob, up to the first wildcard segment. */
function staticPrefix(glob: string): string {
  const out: string[] = [];
  for (const seg of glob.split("/")) {
    if (/[*?[\]{}]/.test(seg)) break;
    out.push(seg);
  }
  return out.join("/");
}

/** Conservative write-scope overlap between two contracts. */
export function scopeConflict(a: TaskContract, b: TaskContract): boolean {
  return a.scope.allowed.some((x) => b.scope.allowed.some((y) => scopesOverlap(staticPrefix(x), staticPrefix(y))));
}

/** Extract the structured payload from model text (fenced block or raw). */
export function extractStructured(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json|yaml|yml)?\s*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
  for (const candidate of [...fences.reverse(), text]) {
    try {
      const parsed = parseYaml(candidate);
      if (isRecord(parsed) || Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
    const brace = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (brace >= 0 && end > brace) {
      try {
        return JSON.parse(candidate.slice(brace, end + 1));
      } catch {
        // not JSON either
      }
    }
  }
  return undefined;
}

/**
 * Parse and validate the planner's output into a contract DAG. `external`
 * names contracts that already passed (replanning) and may be depended on.
 */
export function parsePlannerOutput(input: unknown, opts: { external?: ReadonlySet<string> } = {}): PlanParse {
  const data = typeof input === "string" ? extractStructured(input) : input;
  const root = isRecord(data) && isRecord(data.plan) ? data.plan : data;
  const rawContracts = Array.isArray(root) ? root : isRecord(root) ? root.contracts : undefined;
  if (!Array.isArray(rawContracts)) return { ok: false, errors: ["planner output has no contracts list"] };
  const errors: string[] = [];
  const contracts: TaskContract[] = [];
  for (const raw of rawContracts) {
    const r = parseTaskContract(raw);
    if (r.ok) contracts.push(r.contract);
    else errors.push(...r.errors);
  }
  if (errors.length > 0) return { ok: false, errors };
  const dag = validateContractDag(contracts, opts);
  if (!dag.ok) return { ok: false, errors: dag.errors };
  const meta = isRecord(root) ? root : {};
  const metaErrors: string[] = [];
  const decisions = stringList(meta.decisions, "decisions", metaErrors);
  const architectural_context = stringList(meta.architectural_context, "architectural_context", metaErrors);
  if (metaErrors.length > 0) return { ok: false, errors: metaErrors };
  return { ok: true, plan: { contracts, decisions, architectural_context } };
}
