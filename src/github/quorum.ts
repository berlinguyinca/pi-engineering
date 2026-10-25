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

/** What Herdr said to a re-review request. `refused` is a final answer; `failed` is worth asking again later. */
export interface RereviewAnswer {
  state: "ok" | "refused" | "failed";
  /** Herdr's own request id when it recorded (or replayed) the ask. */
  requestId?: string;
  /** Short, secret-free reason from Herdr's closed error vocabulary. */
  reason?: string;
}

export type RereviewRequester = (prNodeId: string, head: string) => Promise<RereviewAnswer>;

const FULL_HEAD = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const REASON = /^[a-z_]{1,40}$/;

/**
 * Asks Herdr to RECORD a re-review request for a PR's current head
 * (`POST /api/v1/graph/nodes/{pr}/review-quorum/rereview`). Herdr dispatches nothing: AutoSpec (or the operator's
 * command) still performs the review. Pi's own key is used; the key never reaches a log or an error.
 *
 *  - 201 (new) and 200 (replay) are `ok`.
 *  - 403 `not_permitted`, 404 (hidden or absent: the same answer) and 409 `not_required` are final (`refused`):
 *    asking again cannot change them. (A 404 can also mean Herdr never received the PR node; the caller waits for its
 *    lineage outbox to settle before asking, and the operator's `rereview_command` is independent of this ask.)
 *  - 409 `stale_head` / `head_unknown` (Herdr may not have the new head yet), 429, 5xx and any network or shape
 *    problem are `failed`: the caller retries with a bound.
 */
export function createHerdrRereviewRequester(
  conn: Pick<HerdrConnection, "baseUrl" | "apiKey">,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  timeoutMs = 5000,
): RereviewRequester {
  return async (prNodeId, head) => {
    if (!conn.apiKey) return { state: "failed", reason: "no_key" };
    try {
      const res = await fetchImpl(
        `${conn.baseUrl}/api/v1/graph/nodes/${encodeURIComponent(prNodeId)}/review-quorum/rereview`,
        {
          method: "POST",
          redirect: "error",
          headers: { "X-API-Key": conn.apiKey, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(FULL_HEAD.test(head.toLowerCase()) ? { head: head.toLowerCase() } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      let body: Record<string, unknown> = {};
      try {
        const parsed = (await res.json()) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      } catch {
        body = {};
      }
      if (res.status === 200 || res.status === 201) {
        const rr = body.rereview_request as { request_id?: unknown } | undefined;
        const id = rr && typeof rr.request_id === "string" ? rr.request_id : undefined;
        return { state: "ok", ...(id ? { requestId: id.slice(0, 80) } : {}) };
      }
      const code = typeof body.code === "string" && REASON.test(body.code) ? body.code : `http_${res.status}`;
      if (res.status === 403 || res.status === 404 || (res.status === 409 && code === "not_required")) {
        return { state: "refused", reason: code };
      }
      return { state: "failed", reason: code };
    } catch {
      return { state: "failed", reason: "unreachable" };
    }
  };
}
