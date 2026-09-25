/**
 * Request-body budget for the live provider path.
 *
 * The InferWeave gateway on Fry caps a request body at 10 MiB
 * (inferweave-gateway `maxInferenceBody = 10 << 20`); nginx in front allows
 * more, so the gateway's cap is the one that bites, as a permanent
 * "413 http: request body too large". A vision session with four full-size
 * screenshots (~3 MB of base64 each) crossed it and died, because nothing on
 * the live path counted bytes: token-based context management does not see
 * base64 image payloads at all.
 *
 * So every provider call is preflighted here, on a COPY of its context — the
 * session transcript is never touched:
 *
 *   0. images longer than 1800px on either edge are downscaled (spec: vision
 *      payload management §7) whatever the budget — the model sees the same
 *      thing for a fraction of the bytes;
 *   1. over budget, oversized images are re-encoded, oldest first;
 *   2. still over, the OLDEST images become a short text placeholder;
 *   3. still over, the oldest large tool-result texts are truncated;
 *   4. still over — the newest content alone does not fit — the call fails
 *      fast with a non-retryable error naming the size and the limit.
 *
 * The newest turn (everything after the last assistant message) is never
 * dropped or truncated; its images are only ever downscaled.
 *
 * The limit is the gateway's advertised cap when it has told us one (a
 * `max_request_bytes` field on `GET /models`, or the
 * `X-InferWeave-Max-Request-Bytes` header on any response), else a
 * conservative 10 MiB — today's deployed cap — times a headroom factor.
 */

import { createHash } from "node:crypto";
import { DEFAULT_JPEG_QUALITY, DEFAULT_MAX_LONG_EDGE, extractMetadata } from "../vision/processor.ts";

/** Today's deployed gateway cap, used when nothing better is known. */
export const FALLBACK_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
/** Fraction of the cap a request may use: the estimate is close, not exact. */
export const DEFAULT_REQUEST_BODY_HEADROOM = 0.85;
/** Response header through which the gateway advertises its cap. */
export const REQUEST_LIMIT_HEADER = "x-inferweave-max-request-bytes";
/** Re-encode target for one image's base64 when the request is over budget. */
export const IMAGE_REENCODE_TARGET_BYTES = 1024 * 1024;
/** Tool-result text blocks above this may be truncated, keeping this much. */
const TOOL_TEXT_TRUNCATE_ABOVE = 16 * 1024;
const TOOL_TEXT_KEEP = 8 * 1024;
/** Provider wrapper fields (model, stream options, max_tokens, ...). */
const FIXED_OVERHEAD_BYTES = 4096;
/** `{"type":"image_url","image_url":{"url":"data:<mime>;base64,"}}` and friends. */
const PER_IMAGE_OVERHEAD_BYTES = 96;
/** `{"type":"function","function":{...}}` wrapping per tool. */
const PER_TOOL_OVERHEAD_BYTES = 96;
const PLACEHOLDER_PREFIX = "[image omitted to fit the request size limit";

// ─── Budget source ─────────────────────────────────────────────────────────

export interface RequestBodyBudgetConfig {
  /** Explicit operator cap (PI_MAX_REQUEST_BODY_BYTES). Beats an advertised one. */
  maxBytes: number | undefined;
  /** Fraction of the cap a request may use (PI_REQUEST_BODY_HEADROOM). */
  headroom: number;
  /** Cap assumed when neither the operator nor the gateway gave one. */
  fallbackMaxBytes: number;
}

export interface RequestBodyLimit {
  maxBytes: number;
  budgetBytes: number;
  source: "config" | "advertised" | "fallback";
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const n = Number(value.trim());
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

export function resolveRequestBodyBudgetConfig(
  env: Record<string, string | undefined> = process.env,
): RequestBodyBudgetConfig {
  const headroom = Number(env.PI_REQUEST_BODY_HEADROOM);
  return {
    maxBytes: positiveInt(env.PI_MAX_REQUEST_BODY_BYTES),
    headroom: Number.isFinite(headroom) && headroom > 0 && headroom <= 1 ? headroom : DEFAULT_REQUEST_BODY_HEADROOM,
    fallbackMaxBytes: FALLBACK_MAX_REQUEST_BODY_BYTES,
  };
}

/** Advertised caps, keyed by normalized base URL (and `base#model`). */
const advertised = new Map<string, number>();

function baseKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Record a cap the gateway advertised (models listing or header). */
export function noteAdvertisedRequestLimit(baseUrl: string, bytes: unknown, modelId?: string): void {
  const n = typeof bytes === "number" ? bytes : typeof bytes === "string" ? Number(bytes.trim()) : Number.NaN;
  if (!baseUrl || !Number.isFinite(n) || n <= 0) return;
  advertised.set(modelId ? `${baseKey(baseUrl)}#${modelId}` : baseKey(baseUrl), Math.floor(n));
}

/** Record the cap from a response's headers, when it carries one. */
export function noteRequestLimitHeader(baseUrl: string | undefined, headers: unknown): void {
  if (!baseUrl || !headers || typeof headers !== "object") return;
  const get = (headers as { get?: (name: string) => string | null }).get;
  let value: unknown;
  if (typeof get === "function") value = get.call(headers, REQUEST_LIMIT_HEADER);
  else {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === REQUEST_LIMIT_HEADER) value = v;
    }
  }
  if (value !== undefined && value !== null) noteAdvertisedRequestLimit(baseUrl, value);
}

export function advertisedRequestLimit(baseUrl: string | undefined, modelId?: string): number | undefined {
  if (!baseUrl) return undefined;
  const base = baseKey(baseUrl);
  return (modelId ? advertised.get(`${base}#${modelId}`) : undefined) ?? advertised.get(base);
}

/** Forget advertised caps (tests only). */
export function resetAdvertisedRequestLimits(): void {
  advertised.clear();
}

/** The byte budget for one call to `model`. */
export function requestBodyLimit(
  config: RequestBodyBudgetConfig,
  model: { baseUrl?: string; id?: string },
): RequestBodyLimit {
  const known = advertisedRequestLimit(model.baseUrl, model.id);
  const [maxBytes, source]: [number, RequestBodyLimit["source"]] =
    config.maxBytes !== undefined
      ? [config.maxBytes, "config"]
      : known !== undefined
        ? [known, "advertised"]
        : [config.fallbackMaxBytes, "fallback"];
  return { maxBytes, budgetBytes: Math.floor(maxBytes * config.headroom), source };
}

// ─── Estimate ──────────────────────────────────────────────────────────────

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}
interface TextBlock {
  type: "text";
  text: string;
}
interface MessageLike {
  role?: string;
  content?: unknown;
}
/** The slice of pi's `Context` this module reads. */
export interface BudgetContext {
  systemPrompt?: string;
  messages: unknown[];
  tools?: unknown[];
}

function isImage(block: unknown): block is ImageBlock {
  const b = block as Partial<ImageBlock> | null;
  return !!b && b.type === "image" && typeof b.data === "string";
}

function isText(block: unknown): block is TextBlock {
  const b = block as Partial<TextBlock> | null;
  return !!b && b.type === "text" && typeof b.text === "string";
}

function imageCost(image: ImageBlock): number {
  return image.data.length + (image.mimeType?.length ?? 0) + PER_IMAGE_OVERHEAD_BYTES;
}

/**
 * Conservative serialized-body size for `context`.
 *
 * The JSON of the whole context (with image data counted separately, so a
 * 3 MB string is not copied per estimate) over-counts provider framing
 * (per-message metadata pi keeps but never sends) and so never undercounts the
 * real payload; per-image and per-tool framing plus a fixed wrapper cover the
 * rest. Base64 is ASCII, so its length is its byte count.
 */
export function estimateRequestBodyBytes(context: BudgetContext): number {
  let imageBytes = 0;
  const json = JSON.stringify(
    { systemPrompt: context.systemPrompt, messages: context.messages, tools: context.tools },
    (_key, value: unknown) => {
      if (isImage(value)) {
        imageBytes += imageCost(value);
        return { type: "image" };
      }
      return value;
    },
  );
  const tools = Array.isArray(context.tools) ? context.tools.length : 0;
  return Buffer.byteLength(json) + imageBytes + tools * PER_TOOL_OVERHEAD_BYTES + FIXED_OVERHEAD_BYTES;
}

// ─── Fitting ───────────────────────────────────────────────────────────────

export class RequestBodyTooLargeError extends Error {
  readonly estimatedBytes: number;
  readonly limitBytes: number;
  constructor(estimatedBytes: number, limitBytes: number) {
    super(
      `Request body too large to send: estimated ${formatSize(estimatedBytes)} exceeds the ${formatSize(limitBytes)} request budget, even after downscaling images, omitting older images and truncating older tool output. The newest message alone is too big: attach fewer or smaller images, or split the work. Not retryable.`,
    );
    this.name = "RequestBodyTooLargeError";
    this.estimatedBytes = estimatedBytes;
    this.limitBytes = limitBytes;
  }
}

/** Resize contract: pi-coding-agent's `resizeImage` (Photon). */
export type ImageResizer = (
  bytes: Uint8Array,
  mimeType: string,
  options: { maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number },
) => Promise<{ data: string; mimeType: string } | null>;

const defaultResize: ImageResizer = async (bytes, mimeType, options) => {
  const { resizeImage } = await import("@earendil-works/pi-coding-agent");
  return resizeImage(bytes, mimeType, options);
};

export interface FitOptions {
  resize?: ImageResizer;
  maxLongEdge?: number;
}

export interface FitResult<C extends BudgetContext = BudgetContext> {
  /** The context to send: the original object when nothing changed. */
  context: C;
  estimatedBytes: number;
  /** What was done, for logs (e.g. "downscaled 4 images"). */
  actions: string[];
}

/** Re-encodes are expensive and the same old image recurs every turn. */
const resizeCache = new Map<string, { data: string; mimeType: string } | null>();
const RESIZE_CACHE_LIMIT = 64;

async function reencode(
  image: ImageBlock,
  resize: ImageResizer,
  maxLongEdge: number,
): Promise<{ data: string; mimeType: string } | null> {
  const key = `${maxLongEdge}:${createHash("sha256").update(image.data).digest("hex")}`;
  if (resizeCache.has(key)) return resizeCache.get(key) ?? null;
  let result: { data: string; mimeType: string } | null = null;
  try {
    const out = await resize(Buffer.from(image.data, "base64"), image.mimeType, {
      maxWidth: maxLongEdge,
      maxHeight: maxLongEdge,
      maxBytes: IMAGE_REENCODE_TARGET_BYTES,
      jpegQuality: DEFAULT_JPEG_QUALITY,
    });
    result = out && out.data.length < image.data.length ? { data: out.data, mimeType: out.mimeType } : null;
  } catch {
    // A codec failure keeps the original; the later steps still apply.
    result = null;
  }
  resizeCache.set(key, result);
  if (resizeCache.size > RESIZE_CACHE_LIMIT) resizeCache.delete(resizeCache.keys().next().value as string);
  return result;
}

function longEdge(image: ImageBlock): number {
  try {
    const meta = extractMetadata(Buffer.from(image.data, "base64"));
    return Math.max(meta.width ?? 0, meta.height ?? 0);
  } catch {
    return 0;
  }
}

interface ImageRef {
  message: number;
  block: number;
  protected: boolean;
}

/**
 * Sizes in MiB, never as raw byte counts: Pi's own retry matcher has no word
 * boundaries, so a byte count containing "500" or "429" would make it retry a
 * request that can never succeed.
 */
function formatSize(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${mib < 10 ? mib.toFixed(2) : mib.toFixed(1)} MiB`;
}

/**
 * Fit `context` into `budgetBytes`, returning a reduced copy (or the original
 * when it already fits and needs no downscale). Throws RequestBodyTooLargeError
 * when the newest content alone does not fit.
 */
export async function fitRequestBody<C extends BudgetContext>(
  context: C,
  budgetBytes: number,
  opts: FitOptions = {},
): Promise<FitResult<C>> {
  const resize = opts.resize ?? defaultResize;
  const maxLongEdge = opts.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
  const source = context.messages as MessageLike[];
  let lastAssistant = -1;
  for (let i = source.length - 1; i >= 0; i--) {
    if (source[i]?.role === "assistant") {
      lastAssistant = i;
      break;
    }
  }

  const refs: ImageRef[] = [];
  source.forEach((message, m) => {
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((block, b) => {
      if (isImage(block)) refs.push({ message: m, block: b, protected: m > lastAssistant });
    });
  });

  let estimate = estimateRequestBodyBytes(context);
  // Copy-on-write: only messages that change are cloned.
  let messages: MessageLike[] | undefined;
  const cloned = new Set<number>();
  const writable = (m: number): unknown[] => {
    messages ??= source.slice();
    if (!cloned.has(m)) {
      const original = source[m] as MessageLike;
      messages[m] = { ...original, content: (original.content as unknown[]).slice() };
      cloned.add(m);
    }
    return messages[m]?.content as unknown[];
  };
  const current = (ref: { message: number; block: number }): unknown =>
    ((messages ?? source)[ref.message]?.content as unknown[])[ref.block];
  const actions: string[] = [];

  // 0 + 1. Downscale anything over the long-edge cap; over budget, also
  // re-encode images heavier than the per-image target. Oldest first, so the
  // newest are the last to be degraded.
  let downscaled = 0;
  for (const ref of refs) {
    const image = current(ref) as ImageBlock;
    const tooLong = longEdge(image) > maxLongEdge;
    const tooHeavy = estimate > budgetBytes && image.data.length > IMAGE_REENCODE_TARGET_BYTES;
    if (!tooLong && !tooHeavy) continue;
    const out = await reencode(image, resize, maxLongEdge);
    if (!out) continue;
    const next: ImageBlock = { ...image, data: out.data, mimeType: out.mimeType };
    writable(ref.message)[ref.block] = next;
    estimate -= imageCost(image) - imageCost(next);
    downscaled++;
  }
  if (downscaled > 0) actions.push(`downscaled ${downscaled} image(s)`);

  // 2. Oldest images outside the newest turn become placeholders.
  let omitted = 0;
  for (const ref of refs) {
    if (estimate <= budgetBytes) break;
    if (ref.protected) continue;
    const image = current(ref) as ImageBlock;
    const placeholder: TextBlock = {
      type: "text",
      text: `${PLACEHOLDER_PREFIX}: ${image.mimeType}, ${formatSize(image.data.length * 0.75)}]`,
    };
    writable(ref.message)[ref.block] = placeholder;
    estimate -= imageCost(image) - Buffer.byteLength(JSON.stringify(placeholder));
    omitted++;
  }
  if (omitted > 0) actions.push(`omitted ${omitted} older image(s)`);

  // 3. Oldest large tool-result texts outside the newest turn are truncated.
  let truncated = 0;
  for (let m = 0; m <= lastAssistant && estimate > budgetBytes; m++) {
    const message = (messages ?? source)[m];
    if (message?.role !== "toolResult" || !Array.isArray(message.content)) continue;
    message.content.forEach((block, b) => {
      if (estimate <= budgetBytes || !isText(block)) return;
      const size = Buffer.byteLength(block.text);
      if (size <= TOOL_TEXT_TRUNCATE_ABOVE) return;
      const kept = block.text.slice(0, TOOL_TEXT_KEEP);
      const marker = `\n[… ${(size - Buffer.byteLength(kept)).toLocaleString("en-US")} bytes of tool output omitted to fit the request size limit]`;
      const next: TextBlock = { ...block, text: kept + marker };
      writable(m)[b] = next;
      estimate -= Buffer.byteLength(JSON.stringify(block.text)) - Buffer.byteLength(JSON.stringify(next.text));
      truncated++;
    });
  }
  if (truncated > 0) actions.push(`truncated ${truncated} older tool result(s)`);

  const result = messages ? ({ ...context, messages } as C) : context;
  const finalEstimate = messages ? estimateRequestBodyBytes(result) : estimate;
  if (finalEstimate > budgetBytes) throw new RequestBodyTooLargeError(finalEstimate, budgetBytes);
  return { context: result, estimatedBytes: finalEstimate, actions };
}

// ─── A gateway 413 ─────────────────────────────────────────────────────────

const BODY_TOO_LARGE = /request body too large|payload too large|request entity too large|body too large/i;

function formatMiB(bytes: number): string {
  const mib = bytes / (1024 * 1024);
  return `${Number.isInteger(mib) ? mib : mib.toFixed(1)} MiB`;
}

/**
 * Explain a gateway body-size 413, keeping the original text, or undefined
 * when `text` is not one. Permanent: resending the same body cannot succeed.
 */
export function describeRequestTooLarge(text: string | undefined, limitBytes: number): string | undefined {
  if (!text || !BODY_TOO_LARGE.test(text) || /Request body too large to send/.test(text)) return undefined;
  return `${text} — the model gateway rejected the request body as larger than its cap (about ${formatMiB(limitBytes)}). Older images and tool output are reduced automatically before sending; the newest message's attachments are what remains too big. Not retryable as-is.`;
}

// ─── The live-path wrapper ─────────────────────────────────────────────────

interface AttemptLike<E, R> extends AsyncIterable<E> {
  result(): Promise<R>;
}

interface ResultLike {
  stopReason?: string;
  errorMessage?: string;
}

export interface RequestBudgetStreamOptions<M, R> {
  config: RequestBodyBudgetConfig;
  /** Build the assistant error message for a request that cannot be sent. */
  errorResult(model: M, error: Error): R;
  resize?: ImageResizer;
  /** Observe a reduction (telemetry, status line). */
  onFit?(info: { model: M; before: number; after: number; limit: RequestBodyLimit; actions: string[] }): void;
}

/**
 * Wrap a `streamSimple(model, context, options)` so every call is fitted to
 * the request-body budget first. The returned stream is lazy: it awaits the
 * (possibly async) fit, then delegates. A body-size 413 from the gateway is
 * passed through with an explanation; an unsendable request becomes an error
 * event without touching the network.
 */
export function streamWithinRequestBudget<
  M extends { baseUrl?: string; id?: string },
  C extends BudgetContext,
  O,
  E extends { type?: string; error?: R; message?: R },
  R extends ResultLike,
>(
  base: (model: M, context: C, options?: O) => AttemptLike<E, R>,
  opts: RequestBudgetStreamOptions<M, R>,
): (model: M, context: C, options?: O) => AttemptLike<E, R> {
  return (model, context, options) => {
    const limit = requestBodyLimit(opts.config, model);
    const explain = (r: R): R => {
      if (r?.stopReason !== "error") return r;
      const described = describeRequestTooLarge(r.errorMessage, limit.maxBytes);
      return described ? { ...r, errorMessage: described } : r;
    };
    // Learn an advertised cap from any response, success or failure.
    const onResponse = (options as { onResponse?: (response: unknown, m: unknown) => unknown } | undefined)?.onResponse;
    const withHeaderCapture = {
      ...(options ?? {}),
      onResponse: async (response: unknown, m: unknown) => {
        noteRequestLimitHeader(model.baseUrl, (response as { headers?: unknown })?.headers);
        await onResponse?.(response, m);
      },
    } as O;

    let started: Promise<{ inner: AttemptLike<E, R> } | { failed: R }> | undefined;
    const start = () => {
      if (started) return started;
      started = (async () => {
        let fitted: C;
        try {
          const before = estimateRequestBodyBytes(context);
          const fit = await fitRequestBody(context, limit.budgetBytes, {
            ...(opts.resize ? { resize: opts.resize } : {}),
          });
          fitted = fit.context;
          if (fit.actions.length > 0)
            opts.onFit?.({ model, before, after: fit.estimatedBytes, limit, actions: fit.actions });
        } catch (error) {
          return { failed: opts.errorResult(model, error instanceof Error ? error : new Error(String(error))) };
        }
        return { inner: base(model, fitted, withHeaderCapture) };
      })();
      return started;
    };

    return {
      async *[Symbol.asyncIterator]() {
        const s = await start();
        if ("failed" in s) {
          yield { type: "error", reason: "error", error: s.failed } as unknown as E;
          return;
        }
        for await (const event of s.inner) {
          if (event.type === "error" && event.error) yield { ...event, error: explain(event.error) };
          else if (event.type === "done" && event.message) yield { ...event, message: explain(event.message) };
          else yield event;
        }
      },
      async result() {
        const s = await start();
        return "failed" in s ? s.failed : explain(await s.inner.result());
      },
    };
  };
}
