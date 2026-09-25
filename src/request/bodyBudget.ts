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
 *   0. images larger than Pi's own 2000px read cap (pasted screenshots, say)
 *      are downscaled to 1800px without changing format, whatever the budget:
 *      the model sees the same thing for a fraction of the bytes. Images Pi
 *      already sized are left alone, so its coordinate notes stay true; when an
 *      image IS rescaled, its note is rewritten (or added) to match;
 *   1. over budget, images heavier than 1 MiB are re-encoded lossily, oldest
 *      first;
 *   2. still over, the OLDEST images become a short text placeholder —
 *      tool-result images before the user's own;
 *   3. still over, the oldest large tool-result texts are truncated, and the
 *      oldest huge tool-call arguments have their big string fields trimmed;
 *   4. still over — the protected content alone does not fit — the call fails
 *      fast with a non-retryable error naming the size and the limit.
 *
 * Protected, never dropped or truncated: the latest turn (everything from the
 * last assistant message on) and the latest real `user` message.
 *
 * The limit is the gateway's advertised cap when it has told us one (a
 * `max_request_bytes` field on `GET /models`, or the
 * `X-InferWeave-Max-Request-Bytes` header on any response), clamped to a sane
 * range and never above a cap a 413 has taught us; else a conservative 10 MiB
 * — today's deployed cap — times a headroom factor.
 */

import { createHash } from "node:crypto";
import { isAssistantOutputEvent } from "../inference/admissionContract.ts";
import {
  DEFAULT_JPEG_QUALITY,
  DEFAULT_MAX_LONG_EDGE,
  parseJpegDimensions,
  parsePngDimensions,
} from "../vision/processor.ts";

/** Today's deployed gateway cap, used when nothing better is known. */
export const FALLBACK_MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;
/** Fraction of the cap a request may use: the estimate is close, not exact. */
export const DEFAULT_REQUEST_BODY_HEADROOM = 0.85;
/** Response header through which the gateway advertises its cap. */
export const REQUEST_LIMIT_HEADER = "x-inferweave-max-request-bytes";
/** Advertised caps outside this range are clamped: a header is only a hint. */
export const MIN_ADVERTISED_REQUEST_BYTES = 1024 * 1024;
export const MAX_ADVERTISED_REQUEST_BYTES = 64 * 1024 * 1024;
/** Re-encode target for one image's base64 when the request is over budget. */
export const IMAGE_REENCODE_TARGET_BYTES = 1024 * 1024;
/** Pi's read tool already caps images here; anything larger came from elsewhere. */
export const PI_IMAGE_MAX_EDGE = 2000;
/** Tool-result text blocks above this may be truncated, keeping this much. */
const TOOL_TEXT_TRUNCATE_ABOVE = 16 * 1024;
const TOOL_TEXT_KEEP = 8 * 1024;
/** Tool-call argument strings above this may be trimmed, keeping this much. */
const TOOL_ARG_TRUNCATE_ABOVE = 8 * 1024;
const TOOL_ARG_KEEP = 4 * 1024;
/** Provider wrapper fields (model, stream options, max_tokens, ...). */
const FIXED_OVERHEAD_BYTES = 4096;
/** `{"type":"image_url","image_url":{"url":"data:<mime>;base64,"}}` and friends. */
const PER_IMAGE_OVERHEAD_BYTES = 96;
/** `{"type":"function","function":{...}}` wrapping per tool. */
const PER_TOOL_OVERHEAD_BYTES = 96;
const PLACEHOLDER_PREFIX = "[image omitted to fit the request size limit";

// ─── Sizes in messages ─────────────────────────────────────────────────────

/**
 * A human size with no run of three digits.
 *
 * Pi's own retry matcher (pi-ai utils/retry.js) has no word boundaries: "500",
 * "502", "429" anywhere in an error message make it retry. A byte count, or
 * "150.0 MiB", would do exactly that for a request that can never succeed.
 */
export function formatSize(bytes: number): string {
  let value = Math.max(0, bytes) / (1024 * 1024);
  let unit = "MiB";
  for (const next of ["GiB", "TiB", "PiB"]) {
    if (value < 99.95) break;
    value /= 1024;
    unit = next;
  }
  return `${value < 9.995 ? value.toFixed(2) : value.toFixed(1)} ${unit}`;
}

// ─── Budget source ─────────────────────────────────────────────────────────

export interface RequestBodyBudgetConfig {
  /** Explicit operator cap (PI_MAX_REQUEST_BODY_BYTES). Beats everything else. */
  maxBytes: number | undefined;
  /** Fraction of the cap a request may use (PI_REQUEST_BODY_HEADROOM). */
  headroom: number;
  /** Cap assumed when neither the operator nor the gateway gave one. */
  fallbackMaxBytes: number;
}

export interface RequestBodyLimit {
  maxBytes: number;
  budgetBytes: number;
  source: "config" | "advertised" | "learned" | "fallback";
}

function positiveInt(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
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

/**
 * Advertised caps, keyed by normalized base URL and `base#model`. Latest wins
 * per key, so a header seen on a response for a model replaces what the
 * listing said for that model.
 */
const advertised = new Map<string, number>();
/**
 * Caps a 413 taught us, per base URL. Ground truth about the gateway in front
 * of us, which a header relayed from a gateway behind it may overstate. Only
 * ever lowered while it lasts, never below 1 MiB, and forgotten after
 * LEARNED_CAP_TTL_MS so a raised gateway cap is picked up again.
 */
const learned = new Map<string, { bytes: number; at: number }>();
export const LEARNED_CAP_TTL_MS = 30 * 60 * 1000;

function baseKey(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

function keyOf(baseUrl: string, modelId?: string): string {
  return modelId ? `${baseKey(baseUrl)}#${modelId}` : baseKey(baseUrl);
}

/** Record a cap the gateway advertised (models listing or header), clamped. */
export function noteAdvertisedRequestLimit(baseUrl: string, bytes: unknown, modelId?: string): void {
  const n = positiveInt(bytes);
  if (!baseUrl || n === undefined) return;
  advertised.set(
    keyOf(baseUrl, modelId),
    Math.min(MAX_ADVERTISED_REQUEST_BYTES, Math.max(MIN_ADVERTISED_REQUEST_BYTES, n)),
  );
}

/** Record the cap from a response's headers, for the base and (when known) the model. */
export function noteRequestLimitHeader(baseUrl: string | undefined, headers: unknown, modelId?: string): void {
  if (!baseUrl || !headers || typeof headers !== "object") return;
  const get = (headers as { get?: (name: string) => string | null }).get;
  let value: unknown;
  if (typeof get === "function") value = get.call(headers, REQUEST_LIMIT_HEADER);
  else {
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      if (k.toLowerCase() === REQUEST_LIMIT_HEADER) value = v;
    }
  }
  if (value === undefined || value === null) return;
  noteAdvertisedRequestLimit(baseUrl, value);
  if (modelId) noteAdvertisedRequestLimit(baseUrl, value, modelId);
}

/** Record a cap a 413 proved; only ever lowers what is known. */
/**
 * Record a cap a 413 proved. Returns false — and learns nothing — for a value
 * below MIN_ADVERTISED_REQUEST_BYTES: a 413 on a body that small is not a
 * size cap worth shrinking every later request in the process to.
 */
export function noteLearnedRequestLimit(baseUrl: string, bytes: number, now: number = Date.now()): boolean {
  const n = positiveInt(bytes);
  if (!baseUrl || n === undefined || n < MIN_ADVERTISED_REQUEST_BYTES) return false;
  const key = baseKey(baseUrl);
  const current = learnedCap(key, now);
  learned.set(key, { bytes: Math.min(current ?? Number.POSITIVE_INFINITY, n), at: now });
  return true;
}

function learnedCap(key: string, now: number): number | undefined {
  const entry = learned.get(key);
  if (!entry) return undefined;
  if (now - entry.at > LEARNED_CAP_TTL_MS) {
    learned.delete(key);
    return undefined;
  }
  return entry.bytes;
}

export function advertisedRequestLimit(baseUrl: string | undefined, modelId?: string): number | undefined {
  if (!baseUrl) return undefined;
  return (modelId ? advertised.get(keyOf(baseUrl, modelId)) : undefined) ?? advertised.get(keyOf(baseUrl));
}

/** Forget advertised and learned caps (tests only). */
export function resetAdvertisedRequestLimits(): void {
  advertised.clear();
  learned.clear();
}

/** The byte budget for one call to `model`. */
export function requestBodyLimit(
  config: RequestBodyBudgetConfig,
  model: { baseUrl?: string; id?: string },
  now: number = Date.now(),
): RequestBodyLimit {
  const known = advertisedRequestLimit(model.baseUrl, model.id);
  const taught = model.baseUrl ? learnedCap(baseKey(model.baseUrl), now) : undefined;
  let [maxBytes, source]: [number, RequestBodyLimit["source"]] =
    config.maxBytes !== undefined
      ? [config.maxBytes, "config"]
      : known !== undefined
        ? [known, "advertised"]
        : [config.fallbackMaxBytes, "fallback"];
  if (config.maxBytes === undefined && taught !== undefined && taught < maxBytes)
    [maxBytes, source] = [taught, "learned"];
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
interface ToolCallBlock {
  type: "toolCall";
  arguments: unknown;
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

function isToolCall(block: unknown): block is ToolCallBlock {
  const b = block as Partial<ToolCallBlock> | null;
  return !!b && b.type === "toolCall" && b.arguments !== undefined;
}

function imageCost(image: ImageBlock): number {
  return image.data.length + (image.mimeType?.length ?? 0) + PER_IMAGE_OVERHEAD_BYTES;
}

/**
 * Conservative serialized-body size for `context`.
 *
 * The JSON of the whole context over-counts provider framing (per-message
 * metadata pi keeps but never sends). Two things it would otherwise
 * undercount are costed explicitly:
 *
 * - image data, counted separately (so no 3 MB string is copied per estimate)
 *   plus per-image framing — base64 is ASCII, so length is bytes;
 * - tool-call arguments, which OpenAI-style APIs send as a JSON *string*, so
 *   every quote and newline is escaped twice. Costing them that way is also an
 *   upper bound for APIs (Anthropic) that send them as an object.
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
      if (isToolCall(value)) return { ...value, arguments: JSON.stringify(value.arguments) };
      return value;
    },
  );
  const tools = Array.isArray(context.tools) ? context.tools.length : 0;
  return Buffer.byteLength(json) + imageBytes + tools * PER_TOOL_OVERHEAD_BYTES + FIXED_OVERHEAD_BYTES;
}

// ─── Image helpers ─────────────────────────────────────────────────────────

/**
 * Pixel size from the header bytes only. A PNG's IHDR is in the first 24
 * bytes; a JPEG's SOF follows its APP segments, so decode a growing prefix
 * rather than the whole multi-megabyte image.
 */
export function imageDimensions(image: ImageBlock): { width: number; height: number } | null {
  for (const chars of [44, 88_000, 700_000, image.data.length]) {
    const prefix = image.data.slice(0, Math.min(image.data.length, chars - (chars % 4)));
    const bytes = Buffer.from(prefix, "base64");
    const dims = parsePngDimensions(bytes) ?? parseJpegDimensions(bytes);
    if (dims) return dims;
    if (chars >= image.data.length) break;
  }
  return null;
}

/** Resize contract: pi-coding-agent's `resizeImage` (Photon). */
export type ImageResizer = (
  bytes: Uint8Array,
  mimeType: string,
  options: { maxWidth: number; maxHeight: number; maxBytes: number; jpegQuality: number },
) => Promise<{ data: string; mimeType: string; width?: number; height?: number } | null>;

const defaultResize: ImageResizer = async (bytes, mimeType, options) => {
  const { resizeImage } = await import("@earendil-works/pi-coding-agent");
  return resizeImage(bytes, mimeType, options);
};

interface Reencoded {
  data: string;
  mimeType: string;
  width: number;
  height: number;
}

/**
 * Re-encodes are expensive and the same old image recurs every turn.
 *
 * First level: a WeakMap on the image block object itself, which the session
 * keeps stable across turns — no hashing at all on a hit, and no collisions.
 * Second level (a block rebuilt by a conversion): a full sha256 of the data,
 * LRU. Only deterministic outcomes are cached — a resizer that throws or
 * returns nothing is tried again next time.
 */
const blockCache = new WeakMap<object, Map<string, Reencoded | "unchanged">>();
const resizeCache = new Map<string, Reencoded | "unchanged">();
const RESIZE_CACHE_LIMIT = 64;

function cacheKey(mode: string, data: string): string {
  return `${mode}:${createHash("sha256").update(data).digest("hex")}`;
}

function cached(image: ImageBlock, mode: string): Reencoded | "unchanged" | undefined {
  const byBlock = blockCache.get(image)?.get(mode);
  if (byBlock !== undefined) return byBlock;
  const key = cacheKey(mode, image.data);
  const hit = resizeCache.get(key);
  if (hit === undefined) return undefined;
  resizeCache.delete(key);
  resizeCache.set(key, hit);
  remember(image, mode, hit, false);
  return hit;
}

function remember(image: ImageBlock, mode: string, result: Reencoded | "unchanged", global = true): void {
  let perBlock = blockCache.get(image);
  if (!perBlock) {
    perBlock = new Map();
    blockCache.set(image, perBlock);
  }
  perBlock.set(mode, result);
  if (!global) return;
  resizeCache.set(cacheKey(mode, image.data), result);
  if (resizeCache.size > RESIZE_CACHE_LIMIT) resizeCache.delete(resizeCache.keys().next().value as string);
}

async function reencode(
  image: ImageBlock,
  resize: ImageResizer,
  mode: "lossless" | "lossy",
  maxLongEdge: number,
): Promise<Reencoded | null> {
  const modeKey = `${mode}:${maxLongEdge}`;
  const hit = cached(image, modeKey);
  if (hit !== undefined) return hit === "unchanged" ? null : hit;
  // Lossless: the only change is size. A PNG's first candidate is a PNG, and a
  // JPEG must come back no bigger than it went in, which rules out a PNG.
  const maxBytes =
    mode === "lossy"
      ? IMAGE_REENCODE_TARGET_BYTES
      : image.mimeType === "image/png"
        ? Number.MAX_SAFE_INTEGER
        : image.data.length;
  let out: Awaited<ReturnType<ImageResizer>>;
  try {
    out = await resize(Buffer.from(image.data, "base64"), image.mimeType, {
      maxWidth: maxLongEdge,
      maxHeight: maxLongEdge,
      maxBytes,
      jpegQuality: DEFAULT_JPEG_QUALITY,
    });
  } catch {
    return null;
  }
  if (!out) return null;
  const dims = out.width && out.height ? { width: out.width, height: out.height } : imageDimensions(out as ImageBlock);
  const before = imageDimensions(image);
  // Lossless exists to cut pixels (what a vision model pays for), so fewer
  // pixels is enough even if the encoder's bytes come out similar; lossy exists
  // to cut bytes, so it must.
  const useful =
    dims !== null &&
    (mode === "lossless"
      ? before !== null && dims.width * dims.height < before.width * before.height
      : out.data.length < image.data.length);
  const result: Reencoded | "unchanged" =
    useful && dims ? { data: out.data, mimeType: out.mimeType, ...dims } : "unchanged";
  remember(image, modeKey, result);
  return result === "unchanged" ? null : result;
}

/**
 * Pi's read-tool note, a LINE of the text block before the image
 * ("Read image file [image/png]\n[Image: original WxH, displayed at wxh. …]";
 * pi-coding-agent core/tools/read.js, utils/image-process.js).
 */
const DIMENSION_NOTE =
  /^\[Image: original (\d+)x(\d+), displayed at (\d+)x(\d+)\. Multiply coordinates by [\d.]+ to map to original image\.\]$/m;

function dimensionNote(original: { width: number; height: number }, shown: { width: number; height: number }): string {
  const scale = original.width / shown.width;
  return `[Image: original ${original.width}x${original.height}, displayed at ${shown.width}x${shown.height}. Multiply coordinates by ${scale.toFixed(2)} to map to original image.]`;
}

// ─── Fitting ───────────────────────────────────────────────────────────────

export class RequestBodyTooLargeError extends Error {
  readonly estimatedBytes: number;
  readonly limitBytes: number;
  constructor(estimatedBytes: number, limitBytes: number) {
    super(
      `Request body too large to send: estimated ${formatSize(estimatedBytes)} exceeds the ${formatSize(limitBytes)} request budget even after downscaling images, omitting older images and trimming older tool output, so it is out of budget for the model gateway. The newest message alone is too big: attach fewer or smaller images, or split the work. Not retryable.`,
    );
    this.name = "RequestBodyTooLargeError";
    this.estimatedBytes = estimatedBytes;
    this.limitBytes = limitBytes;
  }
}

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

interface ImageRef {
  message: number;
  block: number;
  role: string | undefined;
  protected: boolean;
}

/** Trim big string leaves of a tool call's arguments, keeping every key. */
function trimArguments(value: unknown): { value: unknown; trimmed: boolean } {
  if (typeof value === "string") {
    const size = Buffer.byteLength(value);
    if (size <= TOOL_ARG_TRUNCATE_ABOVE) return { value, trimmed: false };
    const kept = value.slice(0, TOOL_ARG_KEEP);
    return {
      value: `${kept}\n[… ${formatSize(size - Buffer.byteLength(kept))} of tool-call argument omitted to fit the request size limit]`,
      trimmed: true,
    };
  }
  if (Array.isArray(value)) {
    let trimmed = false;
    const out = value.map((item) => {
      const r = trimArguments(item);
      trimmed ||= r.trimmed;
      return r.value;
    });
    return { value: trimmed ? out : value, trimmed };
  }
  if (value && typeof value === "object") {
    let trimmed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const r = trimArguments(v);
      trimmed ||= r.trimmed;
      out[k] = r.value;
    }
    return { value: trimmed ? out : value, trimmed };
  }
  return { value, trimmed: false };
}

/**
 * Fit `context` into `budgetBytes`, returning a reduced copy (or the original
 * when it already fits and needs no downscale). Throws RequestBodyTooLargeError
 * when the protected content alone does not fit.
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
  let lastUser = -1;
  for (let i = source.length - 1; i >= 0 && (lastAssistant < 0 || lastUser < 0); i--) {
    if (lastAssistant < 0 && source[i]?.role === "assistant") lastAssistant = i;
    if (lastUser < 0 && source[i]?.role === "user") lastUser = i;
  }
  const isProtected = (m: number): boolean => m > lastAssistant || m === lastUser;

  const refs: ImageRef[] = [];
  source.forEach((message, m) => {
    if (!Array.isArray(message?.content)) return;
    message.content.forEach((block, b) => {
      if (isImage(block)) refs.push({ message: m, block: b, role: message.role, protected: isProtected(m) });
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
  /**
   * Original size for rescaled images that had no note; the note is written
   * at the end, against the image's final size (inserting shifts indices).
   */
  const pendingNotes = new Map<string, { width: number; height: number }>();

  const rescale = async (ref: ImageRef, mode: "lossless" | "lossy"): Promise<boolean> => {
    const image = current(ref) as ImageBlock;
    const before = imageDimensions(image);
    const out = await reencode(image, resize, mode, maxLongEdge);
    if (!out) return false;
    const content = writable(ref.message);
    content[ref.block] = { ...image, data: out.data, mimeType: out.mimeType };
    estimate -= imageCost(image) - imageCost(content[ref.block] as ImageBlock);
    if (before && (before.width !== out.width || before.height !== out.height)) {
      // Keep coordinates mappable. Pi's own note is a line in the text block
      // next to the image (before it, from the read tool): rewrite that line
      // in place, rebased on the ORIGINAL size it states. Otherwise add one
      // against the size the model knew — once, however often this image is
      // rescaled.
      const key = `${ref.message}:${ref.block}`;
      let rewritten = false;
      for (const at of [ref.block - 1, ref.block + 1]) {
        const block = content[at];
        const match = isText(block) ? DIMENSION_NOTE.exec(block.text) : null;
        if (!match || !isText(block)) continue;
        const original = { width: Number(match[1]), height: Number(match[2]) };
        const text = block.text.replace(match[0], dimensionNote(original, out));
        content[at] = { ...block, text };
        estimate += Buffer.byteLength(text) - Buffer.byteLength(block.text);
        rewritten = true;
        break;
      }
      if (!rewritten && !pendingNotes.has(key)) {
        pendingNotes.set(key, before);
        estimate += Buffer.byteLength(JSON.stringify({ type: "text", text: dimensionNote(before, out) })) + 1;
      }
    }
    return true;
  };

  // 0. Larger than Pi's own cap: downscale, same format, whatever the budget.
  let downscaled = 0;
  for (const ref of refs) {
    const dims = imageDimensions(current(ref) as ImageBlock);
    if (dims && Math.max(dims.width, dims.height) > PI_IMAGE_MAX_EDGE && (await rescale(ref, "lossless"))) downscaled++;
  }
  if (downscaled > 0) actions.push(`downscaled ${downscaled} image(s)`);

  // 1. Over budget: lossy re-encode of heavy images, oldest first.
  let reencoded = 0;
  for (const ref of refs) {
    if (estimate <= budgetBytes) break;
    if ((current(ref) as ImageBlock).data.length <= IMAGE_REENCODE_TARGET_BYTES) continue;
    if (await rescale(ref, "lossy")) reencoded++;
  }
  if (reencoded > 0) actions.push(`re-encoded ${reencoded} image(s)`);

  // 2. Oldest unprotected images become placeholders: tool-result images
  // first, the user's own last.
  let omitted = 0;
  for (const pass of [(r: ImageRef) => r.role !== "user", (r: ImageRef) => r.role === "user"]) {
    for (const ref of refs) {
      if (estimate <= budgetBytes) break;
      if (ref.protected || !pass(ref)) continue;
      const image = current(ref) as ImageBlock;
      if (!isImage(image)) continue;
      const placeholder: TextBlock = {
        type: "text",
        text: `${PLACEHOLDER_PREFIX}: ${image.mimeType}, ${formatSize(image.data.length * 0.75)}]`,
      };
      writable(ref.message)[ref.block] = placeholder;
      pendingNotes.delete(`${ref.message}:${ref.block}`);
      estimate -= imageCost(image) - Buffer.byteLength(JSON.stringify(placeholder));
      omitted++;
    }
  }
  if (omitted > 0) actions.push(`omitted ${omitted} older image(s)`);

  // 3. Oldest large tool results, then oldest huge tool-call arguments.
  let truncated = 0;
  let trimmedCalls = 0;
  for (let m = 0; m < source.length && estimate > budgetBytes; m++) {
    if (isProtected(m)) continue;
    const message = (messages ?? source)[m];
    if (!Array.isArray(message?.content)) continue;
    const blocks = message.content as unknown[];
    for (let b = 0; b < blocks.length && estimate > budgetBytes; b++) {
      const block = blocks[b];
      if (message.role === "toolResult" && isText(block)) {
        const size = Buffer.byteLength(block.text);
        if (size <= TOOL_TEXT_TRUNCATE_ABOVE) continue;
        const kept = block.text.slice(0, TOOL_TEXT_KEEP);
        const marker = `\n[… ${formatSize(size - Buffer.byteLength(kept))} of tool output omitted to fit the request size limit]`;
        const next: TextBlock = { ...block, text: kept + marker };
        writable(m)[b] = next;
        estimate -= Buffer.byteLength(JSON.stringify(block.text)) - Buffer.byteLength(JSON.stringify(next.text));
        truncated++;
      } else if (message.role === "assistant" && isToolCall(block)) {
        const trimmed = trimArguments(block.arguments);
        if (!trimmed.trimmed) continue;
        const next = { ...block, arguments: trimmed.value };
        writable(m)[b] = next;
        const cost = (v: unknown) => Buffer.byteLength(JSON.stringify(JSON.stringify(v)));
        estimate -= cost(block.arguments) - cost(next.arguments);
        trimmedCalls++;
      }
    }
  }
  if (truncated > 0) actions.push(`truncated ${truncated} older tool result(s)`);
  if (trimmedCalls > 0) actions.push(`trimmed ${trimmedCalls} older tool-call argument(s)`);

  // Insert added notes, back to front so earlier indices stay valid.
  const inserts = [...pendingNotes.entries()]
    .flatMap(([key, original]) => {
      const [m, b] = key.split(":").map(Number) as [number, number];
      const image = current({ message: m, block: b });
      const shown = isImage(image) ? imageDimensions(image) : null;
      return shown ? [{ m, b, text: dimensionNote(original, shown) }] : [];
    })
    .sort((x, y) => y.m - x.m || y.b - x.b);
  for (const { m, b, text } of inserts) writable(m).splice(b + 1, 0, { type: "text", text });

  const result = messages ? ({ ...context, messages } as C) : context;
  const finalEstimate = messages ? estimateRequestBodyBytes(result) : estimate;
  if (finalEstimate > budgetBytes) throw new RequestBodyTooLargeError(finalEstimate, budgetBytes);
  return { context: result, estimatedBytes: finalEstimate, actions };
}

// ─── A gateway 413 ─────────────────────────────────────────────────────────

/** Plain wordings, and the gateway's structured code (`request_too_large`). */
const BODY_TOO_LARGE =
  /request body too large|payload too large|request entity too large|body too large|\brequest_too_large\b/i;

/** True for a gateway body-size 413 (not our own preflight refusal). */
export function isBodyTooLarge(text: string | undefined): boolean {
  return !!text && BODY_TOO_LARGE.test(text) && !/Request body too large to send/.test(text);
}

/** A cap stated in a gateway's 413 text ("limit 10485760 bytes", "max 10 MiB"), if any. */
export function limitFromBodyTooLarge(text: string): number | undefined {
  // Preferred: the gateway's JSON 413 states it — {"code":"request_too_large",…,"max_request_bytes":33554432}.
  const field = /"(?:x_)?max_request_bytes"\s*:\s*"?(\d+)/i.exec(text);
  if (field) return positiveInt(field[1]);
  // Text fallback only for an explicit "limit/max … N bytes" or "… N MiB/MB":
  // "request body of N bytes" is the body's size, and a bare number is anything.
  const bytes = /\b(?:limit|max(?:imum)?)\b\D{0,20}?(\d{4,})\s*bytes\b/i.exec(text);
  if (bytes) return positiveInt(bytes[1]);
  const mib = /\b(?:limit|max(?:imum)?)\b\D{0,20}?(\d+(?:\.\d+)?)\s*(MiB|MB)\b/i.exec(text);
  if (mib) return Math.floor(Number(mib[1]) * (mib[2]?.toLowerCase() === "mib" ? 1024 * 1024 : 1_000_000));
  return undefined;
}

/**
 * Explain a gateway body-size 413, keeping the original text, or undefined
 * when `text` is not one. Carries "out of budget", which Pi's retry matcher
 * treats as final, so digits in the gateway's own text cannot trigger a retry.
 */
export function describeRequestTooLarge(text: string | undefined, limitBytes: number): string | undefined {
  if (!isBodyTooLarge(text)) return undefined;
  return `${text} — the model gateway rejected the request body as larger than its cap (about ${formatSize(limitBytes)}), so the request is out of budget. Older images and tool output are reduced automatically before sending; the newest message's attachments are what remains too big. Not retryable as-is.`;
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

/** A minimal push/end stream, so a resend can happen behind one returned stream. */
function eventQueue<E, R>(): AttemptLike<E, R> & { push(e: E): void; end(r: R): void; closed(): boolean } {
  const queue: E[] = [];
  const waiters: Array<() => void> = [];
  let done = false;
  /** The consumer stopped reading (broke out of its loop) before the end. */
  let abandoned = false;
  let final: R | undefined;
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };
  return {
    push(e) {
      queue.push(e);
      wake();
    },
    end(r) {
      if (done) return;
      final = r;
      done = true;
      wake();
    },
    closed: () => abandoned,
    async result() {
      while (!done) await new Promise<void>((resolve) => waiters.push(resolve));
      return final as R;
    },
    async *[Symbol.asyncIterator]() {
      let i = 0;
      try {
        while (true) {
          while (i < queue.length) yield queue[i++] as E;
          if (done) return;
          await new Promise<void>((resolve) => waiters.push(resolve));
        }
      } finally {
        if (!done) abandoned = true;
      }
    },
  };
}

/**
 * Wrap a `streamSimple(model, context, options)` so every call is fitted to
 * the request-body budget first.
 *
 * A body-size 413 that arrives before any output is replay-safe (nothing was
 * delivered): the cap it proves is remembered, the context is re-fitted
 * against it and the request is resent ONCE. Leading non-output events are
 * held back until output starts so that resend never shows a second `start`.
 * Any other 413 is passed on with an explanation; an unsendable request
 * becomes an error event without touching the network.
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
    const out = eventQueue<E, R>();
    const onResponse = (options as { onResponse?: (response: unknown, m: unknown) => unknown } | undefined)?.onResponse;
    const withHeaderCapture = {
      ...(options ?? {}),
      onResponse: async (response: unknown, m: unknown) => {
        noteRequestLimitHeader(model.baseUrl, (response as { headers?: unknown })?.headers, model.id);
        await onResponse?.(response, m);
      },
    } as O;
    const explain = (r: R, limit: RequestBodyLimit): R => {
      if (r?.stopReason !== "error") return r;
      const described = describeRequestTooLarge(r.errorMessage, limit.maxBytes);
      return described ? { ...r, errorMessage: described } : r;
    };
    const fail = (error: unknown) => {
      const failed = opts.errorResult(model, error instanceof Error ? error : new Error(String(error)));
      out.push({ type: "error", reason: "error", error: failed } as unknown as E);
      out.end(failed);
    };
    const fit = async (): Promise<{ context: C; estimate: number; limit: RequestBodyLimit }> => {
      const limit = requestBodyLimit(opts.config, model);
      const before = estimateRequestBodyBytes(context);
      const fitted = await fitRequestBody(context, limit.budgetBytes, opts.resize ? { resize: opts.resize } : {});
      if (fitted.actions.length > 0) {
        opts.onFit?.({ model, before, after: fitted.estimatedBytes, limit, actions: fitted.actions });
      }
      return { context: fitted.context, estimate: fitted.estimatedBytes, limit };
    };

    const signal = (options as { signal?: AbortSignal } | undefined)?.signal;
    const endAborted = () => {
      const aborted = { ...opts.errorResult(model, new Error("Request aborted")), stopReason: "aborted" } as R;
      out.push({ type: "error", reason: "aborted", error: aborted } as unknown as E);
      out.end(aborted);
    };

    void (async () => {
      // Escape before (or during) a slow fit must not send anything.
      if (signal?.aborted) return endAborted();
      let attempt = await fit();
      if (signal?.aborted) return endAborted();
      for (let resend = 0; ; resend++) {
        const inner = base(model, attempt.context, withHeaderCapture);
        const held: E[] = [];
        let visible = false;
        let retryWith: number | undefined;
        for await (const event of inner) {
          // The consumer walked away: stop pulling from the provider.
          if (out.closed()) break;
          const terminal = event.type === "done" || event.type === "error";
          const failure = event.type === "error" ? event.error : event.type === "done" ? event.message : undefined;
          if (
            terminal &&
            !visible &&
            resend === 0 &&
            model.baseUrl !== undefined &&
            opts.config.maxBytes === undefined &&
            failure?.stopReason === "error" &&
            isBodyTooLarge(failure.errorMessage)
          ) {
            // The gateway's stated cap when it gives one, never above what was
            // just refused (so the resend is always smaller); else 80% of it.
            // A cap below 1 MiB is not learned (noteLearnedRequestLimit refuses
            // it): the 413 is then passed on, explained, like any other.
            const stated = limitFromBodyTooLarge(failure.errorMessage ?? "");
            const candidate =
              stated !== undefined
                ? Math.min(stated, Math.floor(attempt.estimate * 0.95))
                : Math.floor(attempt.estimate * 0.8);
            if (noteLearnedRequestLimit(model.baseUrl, candidate)) {
              retryWith = candidate;
              break;
            }
          }
          if (!visible && !terminal && !isAssistantOutputEvent(event.type)) {
            held.push(event);
            continue;
          }
          if (!visible) {
            for (const h of held) out.push(h);
            visible = true;
          }
          if (event.type === "error" && event.error) out.push({ ...event, error: explain(event.error, attempt.limit) });
          else if (event.type === "done" && event.message)
            out.push({ ...event, message: explain(event.message, attempt.limit) });
          else out.push(event);
        }
        if (out.closed()) {
          out.end({ ...opts.errorResult(model, new Error("Request abandoned")), stopReason: "aborted" } as R);
          return;
        }
        if (retryWith !== undefined) {
          attempt = await fit();
          if (signal?.aborted) return endAborted();
          continue;
        }
        if (!visible) for (const h of held) out.push(h);
        out.end(explain(await inner.result(), attempt.limit));
        return;
      }
    })().catch(fail);
    return out;
  };
}
