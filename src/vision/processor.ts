/**
 * VisionAssetProcessor — pure normalization, hashing, derivative sizing and
 * tiling decisions (spec: pi-engineering-vision-payload-management).
 *
 * Pure deterministic logic over plain structured metadata and a tiny defensive
 * PNG/JPEG header dimension parser. No binary pixel decoding.
 */
import { createHash } from "node:crypto";

export const DEFAULT_MAX_LONG_EDGE = 1800;
export const MIN_MAX_LONG_EDGE = 1200;
export const MAX_MAX_LONG_EDGE = 2400;
export const DEFAULT_JPEG_QUALITY = 82;
const DEFAULT_TILE_THRESHOLD = 3000;

export interface ImageMetadata {
  mimeType: string | null;
  width: number | null;
  height: number | null;
  hasAlpha: boolean;
}

export interface DerivativePlan {
  targetWidth: number;
  targetHeight: number;
  format: "jpeg" | "png";
  quality: number;
  tiles: number;
}

function view(buffer: Uint8Array): DataView {
  return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}

function readUInt16BE(buffer: Uint8Array, offset: number): number {
  return view(buffer).getUint16(offset, false);
}

function readUInt32BE(buffer: Uint8Array, offset: number): number {
  return view(buffer).getUint32(offset, false);
}

/** Sniff MIME type from magic bytes; returns null when unrecognized. */
export function detectMimeType(buffer: Uint8Array): string | null {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 6 &&
    buffer[0] === 0x47 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) &&
    buffer[5] === 0x61
  ) {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/** Parse PNG IHDR width/height (big-endian at offsets 16/20). Defensive. */
export function parsePngDimensions(buffer: Uint8Array): { width: number; height: number } | null {
  if (buffer.length < 24) return null;
  if (!(buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)) return null;
  if (!(buffer[12] === 0x49 && buffer[13] === 0x48 && buffer[14] === 0x44 && buffer[15] === 0x52)) return null;
  const width = readUInt32BE(buffer, 16);
  const height = readUInt32BE(buffer, 20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/** Parse JPEG SOF0 (C0) / SOF2 (C2) markers for dimensions. Defensive. */
export function parseJpegDimensions(buffer: Uint8Array): { width: number; height: number } | null {
  if (buffer.length < 4) return null;
  if (!(buffer[0] === 0xff && buffer[1] === 0xd8)) return null;
  let offset = 2;
  while (offset + 2 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;
    while (offset < buffer.length && buffer[offset] === 0xff) offset++;
    if (offset >= buffer.length) break;
    const marker = buffer[offset] as number;
    offset += 1;
    // Standalone markers (no payload length follows).
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x00 || (marker >= 0x01 && marker <= 0x0f)) {
      continue;
    }
    if (offset + 2 > buffer.length) break;
    const length = readUInt16BE(buffer, offset);
    if (length < 2) break;
    if (marker === 0xc0 || marker === 0xc2) {
      if (offset + 2 + 5 > buffer.length) return null;
      const height = readUInt16BE(buffer, offset + 3);
      const width = readUInt16BE(buffer, offset + 5);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }
    offset += length;
  }
  return null;
}

/** PNG color type byte (at offset 25) — 4 and 6 carry an alpha channel. */
function pngHasAlpha(buffer: Uint8Array): boolean {
  if (buffer.length < 26) return false;
  const colorType = buffer[25] as number;
  return colorType === 4 || colorType === 6;
}

/** WebP alpha: lossless VP8L and extended VP8X always carry an alpha channel. */
function webpHasAlpha(buffer: Uint8Array): boolean {
  if (buffer.length < 16) return false;
  const chunk = String.fromCharCode(
    buffer[12] as number,
    buffer[13] as number,
    buffer[14] as number,
    buffer[15] as number,
  );
  return chunk === "VP8L" || chunk === "VP8X";
}

/** Extract normalized image metadata from a byte buffer. Defensive. */
export function extractMetadata(buffer: Uint8Array): ImageMetadata {
  const mimeType = detectMimeType(buffer);
  let width: number | null = null;
  let height: number | null = null;
  let hasAlpha = false;
  if (mimeType === "image/png") {
    const dims = parsePngDimensions(buffer);
    if (dims) {
      width = dims.width;
      height = dims.height;
    }
    hasAlpha = pngHasAlpha(buffer);
  } else if (mimeType === "image/jpeg") {
    const dims = parseJpegDimensions(buffer);
    if (dims) {
      width = dims.width;
      height = dims.height;
    }
  } else if (mimeType === "image/webp") {
    hasAlpha = webpHasAlpha(buffer);
  }
  return { mimeType, width, height, hasAlpha };
}

/** Hex sha256 of a byte buffer. */
export function computeSha256(buffer: Uint8Array): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Scale dimensions to fit within maxLongEdge. Preserves aspect ratio, never
 * upscales, and clamps maxLongEdge to [MIN_MAX_LONG_EDGE, MAX_MAX_LONG_EDGE].
 */
export function scaleDimensions(width: number, height: number, maxLongEdge: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const clamped = Math.min(MAX_MAX_LONG_EDGE, Math.max(MIN_MAX_LONG_EDGE, maxLongEdge));
  const longEdge = Math.max(width, height);
  if (longEdge <= clamped) return { width, height };
  const scale = clamped / longEdge;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

/** True when either dimension exceeds the tiling threshold (default 3000). */
export function shouldTile(width: number, height: number, opts: { threshold?: number } = {}): boolean {
  const threshold = opts.threshold ?? DEFAULT_TILE_THRESHOLD;
  return width > threshold || height > threshold;
}

/**
 * Build a pure derivative plan: scaled dimensions, format (png when
 * transparency must be preserved, else jpeg), quality, and tile count (0 when
 * no tiling, else 4).
 */
export function planDerivative(
  width: number,
  height: number,
  opts: {
    maxLongEdge?: number;
    preserveTransparency?: boolean;
    quality?: number;
    tileThreshold?: number;
  } = {},
): DerivativePlan {
  const maxLongEdge = opts.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;
  const quality = opts.quality ?? DEFAULT_JPEG_QUALITY;
  const scaled = scaleDimensions(width, height, maxLongEdge);
  const format: "jpeg" | "png" = opts.preserveTransparency ? "png" : "jpeg";
  const tiles = shouldTile(width, height, { threshold: opts.tileThreshold }) ? 4 : 0;
  return {
    targetWidth: scaled.width,
    targetHeight: scaled.height,
    format,
    quality,
    tiles,
  };
}
