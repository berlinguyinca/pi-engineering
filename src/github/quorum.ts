/**
 * Reads Herdr's review quorum for a PR node with Pi's configured key. Herdr derives the quorum (trusted reviewers,
 * bound to the PR's head); Pi only reads it, never computes or writes it. Any failure (no key, 404, network, a body
 * that is not the expected shape) is `null`, which the merge gate reads as "no review": fail closed.
 */
import type { HerdrConnection } from "../runtime/herdr/herdrConnection.ts";

export interface QuorumView {
  status: string;
  head: string | null;
  counted: unknown[];
  rereviewRequired: boolean;
}

export type QuorumReader = (prNodeId: string) => Promise<QuorumView | null>;

export function createHerdrQuorumReader(
  conn: Pick<HerdrConnection, "baseUrl" | "apiKey">,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 5000,
): QuorumReader {
  return async (prNodeId) => {
    try {
      const res = await fetchImpl(`${conn.baseUrl}/api/v1/graph/nodes/${encodeURIComponent(prNodeId)}/review-quorum`, {
        method: "GET",
        redirect: "error",
        headers: conn.apiKey ? { "X-API-Key": conn.apiKey } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      if (typeof body.status !== "string") return null;
      return {
        status: body.status,
        head: typeof body.head === "string" ? body.head.toLowerCase() : null,
        counted: Array.isArray(body.counted) ? body.counted : [],
        rereviewRequired: body.rereview_required === true,
      };
    } catch {
      return null;
    }
  };
}
