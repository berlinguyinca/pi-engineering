/**
 * Issue dependency graph (T05). Pure: no I/O, no clock, deterministic ordering.
 *
 * Compatible with AutoSpec's convention (`scripts/project-board-deps.sh`,
 * `crates/autospec-core/src/dependency_gates.rs`, `initiative/dag.rs`):
 *  - an issue body declares prerequisites ONLY inside a `## Dependencies` section, after a
 *    marker phrase (`Blocked by` / `Depends on`, case-insensitive, colon optional); a `#N`
 *    anywhere else, in a fenced code block or in an HTML comment has no effect (bodies are
 *    untrusted data);
 *  - `none` after a marker means no dependency;
 *  - a marker that yields no parseable reference is UNRESOLVABLE and fails closed (never ready);
 *  - a bare `#N` resolves against the issue's own repo, never another;
 *  - an edge is satisfied only by a prerequisite that is KNOWN and closed; an unknown one blocks;
 *  - cycle members and everything downstream of one are not ready.
 * Edge direction is the lineage `dependency` direction: dependent -> prerequisite.
 */
import { type GithubRef, type RefConfig, type RepoKey, extractGithubRefs, refKey, sameRepo } from "./refs.ts";

export type DependencySource = "body" | "native_blocked_by" | "sub_issue" | "operator";

export interface DependencyEdge {
  /** `host/owner/repo#n` of the issue that waits. */
  dependent: string;
  prerequisite: string;
  source: DependencySource;
  crossRepo: boolean;
}

export interface SectionParse {
  refs: GithubRef[];
  /** A marker was used but no reference could be parsed from it (fail closed). */
  unresolvable: boolean;
  reason?: string;
}

export const DEFAULT_DEP_MARKERS: readonly string[] = ["Blocked by", "Depends on"];
const MAX_BODY_SCAN = 64 * 1024;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Body text of every `## Dependencies` section, with code fences and HTML comments removed first. */
export function dependenciesSections(body: string): string {
  const text = (typeof body === "string" ? body.slice(0, MAX_BODY_SCAN) : "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/~~~[\s\S]*?~~~/g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  const out: string[] = [];
  let inSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) {
      inSection = /^##\s+Dependencies\s*$/i.test(line);
      continue;
    }
    if (inSection) out.push(line);
  }
  return out.join("\n");
}

/** Prerequisites declared by an issue body. `selfRepo` resolves bare `#N`. */
export function parseDependencyBody(
  body: string,
  selfRepo: RepoKey,
  cfg: RefConfig = {},
  markers: readonly string[] = DEFAULT_DEP_MARKERS,
): SectionParse {
  const section = dependenciesSections(body);
  const alt = markers
    .map((m) => m.trim())
    .filter(Boolean)
    .map(escapeRegex)
    .join("|");
  if (!section || !alt) return { refs: [], unresolvable: false };
  const marker = new RegExp(`(?:${alt})[ \\t]*:?[ \\t]*([^\\n]*)`, "gi");
  const scopedCfg: RefConfig = { ...cfg, defaultRepo: selfRepo };
  const refs = new Map<string, GithubRef>();
  let unresolvable = false;
  for (const m of section.matchAll(marker)) {
    const rest = (m[1] ?? "").trim();
    if (/^none\b/i.test(rest)) continue;
    const found = extractGithubRefs(rest, scopedCfg);
    if (found.length === 0) unresolvable = true;
    for (const ref of found) refs.set(refKey(ref), ref);
  }
  const list = [...refs.values()];
  if (list.length > 0) return { refs: list, unresolvable: false };
  return unresolvable
    ? { refs: [], unresolvable: true, reason: "## Dependencies names a marker phrase but no reference could be parsed" }
    : { refs: [], unresolvable: false };
}

export interface DependencyItem {
  ref: GithubRef;
  state: "open" | "closed";
  /** Untrusted body; only the Dependencies section is read. */
  body?: string;
  /** GitHub native "blocked by" relation, when the client exposed it. */
  nativeBlockedBy?: readonly GithubRef[];
  /** GitHub native sub-issues of this issue. */
  subIssues?: readonly GithubRef[];
  /** Operator / AutoSpec supplied prerequisites. */
  operatorDeps?: readonly GithubRef[];
}

export interface DependencyGraphOptions {
  cfg?: RefConfig;
  markers?: readonly string[];
  /**
   * `parent_depends_on_children` turns native sub-issues into edges (parent waits for children);
   * default `none`: AutoSpec reads the parent relation the other way round, so Pi does not guess.
   */
  subIssueEdges?: "none" | "parent_depends_on_children";
}

export interface DependencyGraph {
  nodes: Map<string, { key: string; ref: GithubRef; state: "open" | "closed" }>;
  edges: DependencyEdge[];
  unresolvable: Map<string, string>;
}

export function buildDependencyGraph(
  items: readonly DependencyItem[],
  options: DependencyGraphOptions = {},
): DependencyGraph {
  const cfg = options.cfg ?? {};
  const nodes: DependencyGraph["nodes"] = new Map();
  const edgeMap = new Map<string, DependencyEdge>();
  const unresolvable = new Map<string, string>();
  for (const item of items) nodes.set(refKey(item.ref), { key: refKey(item.ref), ref: item.ref, state: item.state });

  const addEdge = (dependent: GithubRef, prerequisite: GithubRef, source: DependencySource): void => {
    const edge: DependencyEdge = {
      dependent: refKey(dependent),
      prerequisite: refKey(prerequisite),
      source,
      crossRepo: !sameRepo(dependent, prerequisite),
    };
    const id = `${edge.dependent}->${edge.prerequisite}`;
    if (!edgeMap.has(id)) edgeMap.set(id, edge);
  };

  for (const item of items) {
    const key = refKey(item.ref);
    if (item.body) {
      const parsed = parseDependencyBody(item.body, item.ref, cfg, options.markers);
      for (const ref of parsed.refs) addEdge(item.ref, ref, "body");
      if (parsed.unresolvable) unresolvable.set(key, parsed.reason ?? "unresolvable dependency declaration");
    }
    for (const ref of item.nativeBlockedBy ?? []) addEdge(item.ref, ref, "native_blocked_by");
    for (const ref of item.operatorDeps ?? []) addEdge(item.ref, ref, "operator");
    if (options.subIssueEdges === "parent_depends_on_children") {
      for (const child of item.subIssues ?? []) addEdge(item.ref, child, "sub_issue");
    }
  }
  const edges = [...edgeMap.values()].sort((a, b) =>
    a.dependent === b.dependent ? a.prerequisite.localeCompare(b.prerequisite) : a.dependent.localeCompare(b.dependent),
  );
  return { nodes, edges, unresolvable };
}

export function crossRepoEdges(graph: DependencyGraph): DependencyEdge[] {
  return graph.edges.filter((e) => e.crossRepo);
}

/** Strongly connected components with a cycle (size > 1 or a self-edge). Iterative Tarjan; sorted output. */
export function findCycles(graph: DependencyGraph): string[][] {
  const adj = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = adj.get(e.dependent) ?? [];
    list.push(e.prerequisite);
    adj.set(e.dependent, list);
  }
  const vertices = new Set<string>();
  for (const e of graph.edges) {
    vertices.add(e.dependent);
    vertices.add(e.prerequisite);
  }
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  for (const root of [...vertices].sort()) {
    if (index.has(root)) continue;
    const work: Array<{ v: string; i: number }> = [{ v: root, i: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1] as { v: string; i: number };
      const next = adj.get(frame.v) ?? [];
      if (frame.i < next.length) {
        const w = next[frame.i++] as string;
        if (!index.has(w)) {
          index.set(w, counter);
          low.set(w, counter);
          counter++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, i: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v) as number, index.get(w) as number));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.v, Math.min(low.get(parent.v) as number, low.get(frame.v) as number));
      if (low.get(frame.v) === index.get(frame.v)) {
        const component: string[] = [];
        let w: string | undefined;
        do {
          w = stack.pop() as string;
          onStack.delete(w);
          component.push(w);
        } while (w !== frame.v);
        const selfLoop =
          component.length === 1 && (adj.get(component[0] as string) ?? []).includes(component[0] as string);
        if (component.length > 1 || selfLoop) cycles.push(component.sort());
      }
    }
  }
  return cycles.sort((a, b) => (a[0] as string).localeCompare(b[0] as string));
}

export interface ReadinessReport {
  /** Open issues whose every prerequisite is known and closed. Sorted. */
  ready: string[];
  blocked: Array<{ key: string; reasons: string[] }>;
  cycles: string[][];
}

/**
 * Ready set: an OPEN issue is ready only when it has no unresolvable declaration, is neither in
 * nor downstream of a cycle, and each prerequisite is a known, closed node. An unknown
 * prerequisite blocks (fails closed). Closed issues are neither ready nor blocked.
 */
export function computeReadiness(graph: DependencyGraph): ReadinessReport {
  const cycles = findCycles(graph);
  const inCycle = new Set(cycles.flat());
  const prereqs = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = prereqs.get(e.dependent) ?? [];
    list.push(e.prerequisite);
    prereqs.set(e.dependent, list);
  }
  // Downstream of a cycle: fixpoint over "has a prerequisite that is cyclic or cycle-blocked".
  const cycleBlocked = new Set(inCycle);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [dependent, list] of prereqs) {
      if (!cycleBlocked.has(dependent) && list.some((p) => cycleBlocked.has(p))) {
        cycleBlocked.add(dependent);
        changed = true;
      }
    }
  }
  const ready: string[] = [];
  const blocked: ReadinessReport["blocked"] = [];
  for (const key of [...graph.nodes.keys()].sort()) {
    const node = graph.nodes.get(key);
    if (!node || node.state !== "open") continue;
    const reasons: string[] = [];
    const why = graph.unresolvable.get(key);
    if (why) reasons.push(`unresolvable: ${why}`);
    if (inCycle.has(key)) reasons.push("member of a dependency cycle");
    else if (cycleBlocked.has(key)) reasons.push("downstream of a dependency cycle");
    for (const p of [...new Set(prereqs.get(key) ?? [])].sort()) {
      const target = graph.nodes.get(p);
      if (!target) reasons.push(`prerequisite ${p} is unknown`);
      else if (target.state !== "closed") reasons.push(`prerequisite ${p} is open`);
    }
    if (reasons.length === 0) ready.push(key);
    else blocked.push({ key, reasons });
  }
  return { ready, blocked, cycles };
}
