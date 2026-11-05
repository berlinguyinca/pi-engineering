/**
 * Read-back of the Herdr lineage graph. Pi pushes lineage (lineage.ts); this is the other direction, so a task's
 * sessions, plans, commits, PRs and verification can be shown from Pi as well as from the dashboard.
 *
 * The Herdr graph stays the single owner: this is a thin GET of `/api/v1/graph/nodes/<id>/neighborhood` with the SAME
 * connection (`herdr:` block of the global YAML: url + api_key_file) the quorum reader and lineage already use. No
 * second transport, no store of its own beyond a tiny in-memory TTL cache, no new secret, no environment variable.
 *
 * Never throws and never rejects: every failure (no connection, timeout, HTTP error, 404, a body that is not the
 * expected shape) is `{ state: "unavailable" }`, so a UI that renders it cannot be broken by Herdr being down. Herdr
 * filters by the caller's visibility, so a hidden node and a missing node are the same 404 and are reported the same
 * way (`not_found`), which also means an answer never says more than the key may see.
 */

import type { HerdrConnection } from "./herdrConnection.ts";
import { lineageNodeId } from "./lineage.ts";

export interface GraphNodeView {
  id: string;
  type: string;
  label: string | null;
  state: string | null;
  attrs: Record<string, unknown>;
}

export interface GraphEdgeView {
  type: string;
  from: string;
  to: string;
  stale: boolean;
  removed: boolean;
  attrs: Record<string, unknown>;
}

export interface TaskGraph {
  root: string;
  nodes: GraphNodeView[];
  edges: GraphEdgeView[];
  /** Herdr cut the answer (node/edge/byte cap); what is shown is a visible subset, never a guess. */
  truncated: boolean;
}

export type GraphReadResult =
  | { state: "ok"; graph: TaskGraph; cached: boolean }
  | { state: "not_found" }
  | { state: "unavailable"; reason: string };

export interface GraphReaderOptions {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Fresh answers are reused for this long. Failures are cached for a shorter time so a dead Herdr is not hammered. */
  ttlMs?: number;
  depth?: number;
  now?: () => number;
}

export interface GraphReader {
  getTaskGraph(taskId: string): Promise<GraphReadResult>;
}

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_TTL_MS = 15_000;
const FAILURE_TTL_MS = 5_000;
const MAX_CACHE = 64;
const MAX_NODES = 200;
const MAX_EDGES = 500;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

/** Pure: parse a neighborhood body. Undefined when it does not have the documented shape. */
export function parseNeighborhood(body: unknown): TaskGraph | undefined {
  if (!isObj(body) || typeof body.root !== "string" || !Array.isArray(body.nodes) || !Array.isArray(body.edges)) {
    return undefined;
  }
  const nodes: GraphNodeView[] = [];
  for (const n of body.nodes.slice(0, MAX_NODES)) {
    if (!isObj(n) || typeof n.id !== "string" || typeof n.node_type !== "string") continue;
    nodes.push({
      id: n.id,
      type: n.node_type,
      label: str(n.label),
      state: str(n.state),
      attrs: isObj(n.attrs) ? n.attrs : {},
    });
  }
  const edges: GraphEdgeView[] = [];
  for (const e of body.edges.slice(0, MAX_EDGES)) {
    if (!isObj(e) || typeof e.edge_type !== "string" || typeof e.from_id !== "string" || typeof e.to_id !== "string") {
      continue;
    }
    edges.push({
      type: e.edge_type,
      from: e.from_id,
      to: e.to_id,
      stale: e.stale === true,
      removed: e.removed === true,
      attrs: isObj(e.attrs) ? e.attrs : {},
    });
  }
  return { root: body.root, nodes, edges, truncated: body.truncated === true };
}

export function createGraphReader(
  conn: Pick<HerdrConnection, "baseUrl" | "apiKey"> | null | undefined,
  opts: GraphReaderOptions = {},
): GraphReader {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const depth = opts.depth ?? 2;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; ttl: number; result: GraphReadResult }>();

  const remember = (key: string, result: GraphReadResult, ttl: number): GraphReadResult => {
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { at: now(), ttl, result });
    return result;
  };

  const read = async (nodeId: string): Promise<GraphReadResult> => {
    if (!conn) return { state: "unavailable", reason: "herdr is not configured" };
    const hit = cache.get(nodeId);
    if (hit && now() - hit.at < hit.ttl) {
      return hit.result.state === "ok" ? { ...hit.result, cached: true } : hit.result;
    }
    try {
      const url =
        `${conn.baseUrl}/api/v1/graph/nodes/${encodeURIComponent(nodeId)}/neighborhood` +
        `?depth=${depth}&max_nodes=${MAX_NODES}&max_edges=${MAX_EDGES}`;
      const res = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: conn.apiKey ? { "X-API-Key": conn.apiKey } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 404) return remember(nodeId, { state: "not_found" }, ttlMs);
      if (!res.ok)
        return remember(nodeId, { state: "unavailable", reason: `herdr answered ${res.status}` }, FAILURE_TTL_MS);
      const graph = parseNeighborhood(await res.json());
      if (!graph) return remember(nodeId, { state: "unavailable", reason: "unexpected response" }, FAILURE_TTL_MS);
      return remember(nodeId, { state: "ok", graph, cached: false }, ttlMs);
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return remember(
        nodeId,
        { state: "unavailable", reason: timedOut ? "timed out" : "herdr unreachable" },
        FAILURE_TTL_MS,
      );
    }
  };

  return {
    async getTaskGraph(taskId) {
      try {
        const node = lineageNodeId("task", taskId);
        if (!node) return { state: "not_found" };
        return await read(node);
      } catch {
        return { state: "unavailable", reason: "internal error" };
      }
    },
  };
}

/** Pure formatter for a terminal/notify surface. Plain text, bounded, control characters removed. */
export function formatTaskGraph(result: GraphReadResult, taskId: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
  const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 120);
  if (result.state === "unavailable") return `Task ${clean(taskId)}: Herdr graph unavailable (${result.reason}).`;
  if (result.state === "not_found")
    return `Task ${clean(taskId)}: not in the Herdr graph (or not visible to this key).`;
  const { graph } = result;
  const rootId = lineageNodeId("task", taskId);
  const lines = [`Task ${clean(taskId)} (Herdr graph${result.cached ? ", cached" : ""})`];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const label = (id: string) => {
    const n = byId.get(id);
    return n?.label ? `${id} "${clean(n.label)}"` : id;
  };
  const rows = graph.edges
    .filter((e) => !e.removed)
    .map(
      (e) =>
        `  ${e.from === rootId ? "->" : "  "} ${e.type}${e.stale ? " (stale)" : ""}: ${label(e.from)} -> ${label(e.to)}`,
    )
    .sort();
  if (rows.length === 0) lines.push("  no linked nodes");
  else lines.push(...rows.slice(0, 40));
  if (rows.length > 40) lines.push(`  ... ${rows.length - 40} more edges`);
  if (graph.truncated) lines.push("  (Herdr truncated this view)");
  return lines.join("\n");
}
