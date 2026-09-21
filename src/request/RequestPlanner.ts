/**
 * RequestPlanner — architectural 413 prevention (herdr spec 06).
 *
 * The observed failure signature is: a task accumulates many design references /
 * spec contents inlined into the request → the serialized request body grows →
 * the HTTP gateway rejects it with `413 request body too large`.
 *
 * The fix is NOT to raise the HTTP limit. It is to plan the request BEFORE
 * submission:
 *  1. discover the context window from runtime/InferWeave metadata (never a
 *     fixed 260K — see src/context/capability.ts),
 *  2. budget BOTH tokens and serialized bytes with headroom,
 *  3. if the raw request exceeds the byte budget, transform it — materialize
 *     reference contents into artifacts (pass refs, not blobs), then summarize —
 *  4. if it still cannot fit, split into a fan-out of smaller requests (or
 *     reject with a structured error when a single objective cannot fit).
 *
 * The planner is pure (no I/O): transformation is deterministic and testable.
 */

import { CONSERVATIVE_FALLBACK_CONTEXT, resolveModelContext } from "../context/capability.ts";
import type { ModelCapability } from "../context/capability.ts";

/** A design reference / spec content that would otherwise be inlined. */
export interface RequestReference {
  id: string;
  title: string;
  content: string;
}

export interface RequestPlannerInput {
  objective: string;
  references?: RequestReference[];
  images?: Array<{ id: string; bytes: number }>;
  /** Context window, if already discovered; else discovered via capability. */
  contextWindow?: number;
  modelId?: string;
  capability?: ModelCapability;
  /** Serialized request-body ceiling set by the gateway (the 413 source). */
  maxRequestBytes?: number;
  /** Headroom to keep requests safely under the ceiling. */
  headroomRatio?: number;
  /** Max content bytes to inline for a single reference after materialization. */
  referenceInlineBytes?: number;
}

export type PlanMode = "direct" | "materialize" | "summarize" | "split" | "reject";

export interface RequestPlan {
  mode: PlanMode;
  /** Discovered context window (never a fixed 260K). */
  contextWindow: number;
  /** Effective byte budget the request must fit under. */
  byteBudget: number;
  /** Estimated serialized bytes of the raw request. */
  rawBytes: number;
  /** Estimated serialized bytes of the planned request. */
  plannedBytes: number;
  /** Whether the planned request fits the byte budget. */
  fits: boolean;
  /** Artifacts created to hold materialized/summarized reference content. */
  artifactRefs: string[];
  /** References that will be inlined (small enough). */
  inlineRefs: string[];
  /** References replaced by artifact refs. */
  materializedRefs: string[];
  /** Chunks for a split/fan-out plan (empty unless mode === "split"). */
  chunks?: Array<{ objective: string; referenceIds: string[] }>;
  /** Structured rejection reason (set when mode === "reject"). */
  rejection?: { code: string; message: string };
  /** Human-readable explanation of what transformation was applied. */
  reasons: string[];
}

const DEFAULT_HEADROOM = 0.85;
const DEFAULT_MAX_REQUEST_BYTES = 4_000_000;
const DEFAULT_REFERENCE_INLINE_BYTES = 24_000;

function estimateBytes(obj: unknown): number {
  // Serialized body length is the actual 413 trigger; JSON.stringify is the
  // closest pre-submission proxy and is deterministic.
  try {
    return Buffer.byteLength(JSON.stringify(obj), "utf8");
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/**
 * Discover the context window from metadata (spec 05). Reuses the capability
 * resolver so the conservative floor (128K, never 260K) applies when nothing
 * trustworthy is known.
 */
export function discoverContextWindow(
  input: Pick<RequestPlannerInput, "contextWindow" | "modelId" | "capability">,
): number {
  if (input.contextWindow !== undefined) return input.contextWindow;
  const resolved = resolveModelContext(input.modelId ?? "unknown", input.capability);
  return resolved.contextWindow ?? CONSERVATIVE_FALLBACK_CONTEXT;
}

/** Build a request that fits the byte/token budgets, transforming if needed. */
export function planRequest(input: RequestPlannerInput): RequestPlan {
  const contextWindow = discoverContextWindow(input);
  const headroomRatio = input.headroomRatio ?? DEFAULT_HEADROOM;
  const maxRequestBytes = input.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const referenceInlineBytes = input.referenceInlineBytes ?? DEFAULT_REFERENCE_INLINE_BYTES;
  const byteBudget = Math.floor(maxRequestBytes * headroomRatio);
  const refs = input.references ?? [];

  const reasons: string[] = [];
  const artifactRefs: string[] = [];
  const inlineRefs: string[] = [];
  const materializedRefs: string[] = [];

  // Raw, unplanned request (this is what previously grew into a 413).
  const raw = { objective: input.objective, references: refs, images: input.images ?? [] };
  const rawBytes = estimateBytes(raw);

  const makePayload = (objective: string, transformed: RequestReference[]): unknown => ({
    objective,
    references: transformed,
    images: input.images ?? [],
  });

  // Token budget check too: the body may be under the byte ceiling but still
  // overflow the context window.
  const tokenEstimate = estimateTokens(input.objective) + refs.reduce((s, r) => s + estimateTokens(r.content), 0);
  const tokenBudget = Math.floor(contextWindow * headroomRatio);

  if (rawBytes <= byteBudget && tokenEstimate <= tokenBudget) {
    return {
      mode: "direct",
      contextWindow,
      byteBudget,
      rawBytes,
      plannedBytes: rawBytes,
      fits: true,
      artifactRefs,
      inlineRefs: refs.map((r) => r.id),
      materializedRefs,
      reasons: ["request already within byte and token budgets"],
    };
  }
  reasons.push(`raw request ${rawBytes} bytes / ~${tokenEstimate} tokens exceeds budget`);

  // ── Pass 1: materialize oversized references into artifacts (artifact-first).
  const transformed: RequestReference[] = refs.map((r) => {
    if (r.content.length > referenceInlineBytes) {
      const ref = `artifact://ref/${r.id}`;
      artifactRefs.push(ref);
      materializedRefs.push(r.id);
      reasons.push(`materialized '${r.id}' (${r.content.length} B) into ${ref}`);
      return { id: r.id, title: r.title, content: `[see ${ref}]` };
    }
    inlineRefs.push(r.id);
    return r;
  });
  let planned = makePayload(input.objective, transformed);
  let plannedBytes = estimateBytes(planned);
  let tokenNow = estimateTokens(input.objective) + transformed.reduce((s, r) => s + estimateTokens(r.content), 0);

  if (plannedBytes <= byteBudget && tokenNow <= tokenBudget) {
    return {
      mode: "materialize",
      contextWindow,
      byteBudget,
      rawBytes,
      plannedBytes,
      fits: true,
      artifactRefs,
      inlineRefs,
      materializedRefs,
      reasons,
    };
  }
  reasons.push(`after materialization still ${plannedBytes} bytes / ~${tokenNow} tokens`);

  // ── Pass 2: summarize remaining inline references to a small fixed budget.
  const summaryBudget = Math.max(
    256,
    Math.floor((byteBudget - estimateBytes(input.objective)) / Math.max(1, inlineRefs.length)),
  );
  const summarized: RequestReference[] = transformed.map((r) => {
    if (r.content.length <= referenceInlineBytes && r.content.length > summaryBudget) {
      return { id: r.id, title: r.title, content: `${r.content.slice(0, summaryBudget)}…` };
    }
    return r;
  });
  planned = makePayload(input.objective, summarized);
  plannedBytes = estimateBytes(planned);
  tokenNow = estimateTokens(input.objective) + summarized.reduce((s, r) => s + estimateTokens(r.content), 0);
  if (plannedBytes <= byteBudget && tokenNow <= tokenBudget) {
    return {
      mode: "summarize",
      contextWindow,
      byteBudget,
      rawBytes,
      plannedBytes,
      fits: true,
      artifactRefs,
      inlineRefs,
      materializedRefs,
      reasons,
    };
  }
  reasons.push(`after summarization still ${plannedBytes} bytes / ~${tokenNow} tokens`);

  // ── Pass 3: split/fan-out into chunks that each fit.
  const chunks = partition(summarized, byteBudget, input.objective, input.images ?? []);
  if (chunks.length > 1) {
    const maxChunkBytes = Math.max(...chunks.map((c) => c.bytes));
    return {
      mode: "split",
      contextWindow,
      byteBudget,
      rawBytes,
      plannedBytes: maxChunkBytes,
      fits: true,
      artifactRefs,
      inlineRefs,
      materializedRefs,
      chunks: chunks.map((c) => ({
        objective: `${input.objective} — part ${c.index + 1}/${chunks.length}`,
        referenceIds: c.ids,
      })),
      reasons: [...reasons, `split into ${chunks.length} fan-out chunks (largest ${maxChunkBytes} bytes)`],
    };
  }

  // ── Pass 4: preflight rejection — a single objective that cannot fit.
  return {
    mode: "reject",
    contextWindow,
    byteBudget,
    rawBytes,
    plannedBytes,
    fits: false,
    artifactRefs,
    inlineRefs,
    materializedRefs,
    rejection: {
      code: "request_too_large",
      message: `request body ~${rawBytes} bytes exceeds the ${byteBudget}-byte budget and cannot be split or summarized; reduce scope or fan out manually`,
    },
    reasons: [...reasons, "could not fit request within budget; rejecting before submission"],
  };
}

interface Chunk {
  index: number;
  ids: string[];
  bytes: number;
}

function partition(
  refs: RequestReference[],
  byteBudget: number,
  objective: string,
  images: Array<{ id: string; bytes: number }>,
): Chunk[] {
  const base = estimateBytes({ objective, references: [], images });
  const perChunk = Math.max(1, byteBudget - base);
  const chunks: Chunk[] = [];
  let cur: Chunk = { index: 1, ids: [], bytes: base };
  for (const r of refs) {
    const rBytes = estimateBytes({ objective, references: [r], images });
    if (cur.ids.length > 0 && cur.bytes + rBytes > byteBudget) {
      chunks.push(cur);
      cur = { index: chunks.length + 1, ids: [], bytes: base };
    }
    cur.ids.push(r.id);
    cur.bytes += rBytes;
  }
  if (cur.ids.length > 0) chunks.push(cur);
  return chunks;
}
