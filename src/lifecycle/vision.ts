/**
 * Vision routing (spec §16).
 *
 * Image-bearing work is handed to a vision-capable model regardless of what the
 * parent model advertises, because a parent that *claims* vision is not proof
 * that it saw the image. Image analysis is cached by content hash so repeated
 * lifecycle rounds over identical screenshots cost nothing extra.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import { hasCapability } from "../capability/modelRecord.ts";
import type { WorkerImage } from "../workers/WorkerExecutor.ts";
import type { ModelRecord, ModelRef } from "./types.ts";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Detect whether a model can actually accept image input. */
export function isVisionCapable(rec: ModelRecord): boolean {
  return rec.modalities.includes("image") || hasCapability(rec, "vision");
}

export interface ImageCandidate {
  path: string;
  mimeType: string;
  bytes: number;
}

/** Image files present in a change set, largest-first bounded. */
export function imageFilesIn(paths: string[], opts: { max?: number } = {}): ImageCandidate[] {
  return paths
    .filter(isImagePath)
    .map((p) => ({ path: p, mimeType: MIME[extname(p).toLowerCase()] ?? "image/png", bytes: 0 }))
    .slice(0, opts.max ?? 8);
}

/** Read image candidates from disk, skipping anything that cannot be read. */
export async function loadImageFiles(cwd: string, candidates: ImageCandidate[]): Promise<WorkerImage[]> {
  const out: WorkerImage[] = [];
  for (const candidate of candidates) {
    try {
      const absolute = resolve(cwd, candidate.path);
      const info = await stat(absolute);
      if (!info.isFile() || info.size === 0 || info.size > 8 * 1024 * 1024) continue;
      const buf = await readFile(absolute);
      out.push({ data: buf.toString("base64"), mimeType: candidate.mimeType, label: candidate.path });
    } catch {
      // A deleted or unreadable screenshot must not fail the whole lifecycle.
    }
  }
  return out;
}

export interface CaptureResult {
  images: WorkerImage[];
  command: string;
  status: "captured" | "not_configured" | "failed" | "unsupported";
  detail: string;
}

/**
 * Run an operator/repo-declared screenshot command and collect the images it
 * produced. Never synthesised: without a declared capture command the harness
 * reports `not_configured` and vision review proceeds with whatever images the
 * user attached.
 */
export async function captureScreenshots(args: {
  cwd: string;
  command?: string;
  globDir?: string;
  timeoutMs: number;
  /** Only files modified after this timestamp count as fresh captures. */
  newerThan: number;
}): Promise<CaptureResult> {
  if (!args.command) {
    return { images: [], command: "", status: "not_configured", detail: "no vision.capture_command configured" };
  }
  const targetDir = args.globDir ?? args.cwd;
  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    await promisify(exec)(args.command, { cwd: args.cwd, timeout: args.timeoutMs, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    return {
      images: [],
      command: args.command,
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  const found: ImageCandidate[] = [];
  try {
    for (const entry of await collectFiles(targetDir, 4)) {
      if (!isImagePath(entry)) continue;
      const info = await stat(join(targetDir, entry)).catch(() => undefined);
      if (!info || info.mtimeMs < args.newerThan) continue;
      found.push({
        path: relative(args.cwd, join(targetDir, entry)),
        mimeType: MIME[extname(entry).toLowerCase()] ?? "image/png",
        bytes: info.size,
      });
    }
  } catch {
    return { images: [], command: args.command, status: "unsupported", detail: "capture output directory unreadable" };
  }
  const images = await loadImageFiles(args.cwd, found.slice(0, 8));
  return {
    images,
    command: args.command,
    status: images.length ? "captured" : "unsupported",
    detail: images.length ? `${images.length} captured image(s)` : "capture command produced no new images",
  };
}

async function collectFiles(root: string, depth: number): Promise<string[]> {
  if (depth < 0) return [];
  const out: string[] = [];
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: "utf-8" });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (entry.isDirectory()) {
      for (const nested of await collectFiles(join(root, entry.name), depth - 1)) out.push(join(entry.name, nested));
    } else if (entry.isFile()) {
      out.push(entry.name);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Content-hash cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  hash: string;
  model: ModelRef;
  summary: string;
  at: string;
}

export class VisionCache {
  private entries = new Map<string, CacheEntry>();
  private writeChain: Promise<void> = Promise.resolve();

  private readonly file: string | undefined;
  private readonly enabled: boolean;

  private constructor(file: string | undefined, enabled: boolean) {
    this.file = file;
    this.enabled = enabled;
  }

  static async open(file: string | undefined, enabled: boolean): Promise<VisionCache> {
    const cache = new VisionCache(enabled ? file : undefined, enabled);
    if (enabled && file) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf-8")) as { entries?: CacheEntry[] };
        for (const entry of parsed.entries ?? []) cache.entries.set(entry.hash, entry);
      } catch {
        // Cold cache.
      }
    }
    return cache;
  }

  static key(images: WorkerImage[], role: string, model: ModelRef, promptVersion = "v1"): string {
    const hash = createHash("sha256");
    hash.update(promptVersion);
    hash.update(role);
    hash.update(`${model.provider}/${model.id}`);
    for (const img of images) {
      hash.update(img.mimeType);
      hash.update(img.data);
    }
    return hash.digest("hex");
  }

  get(key: string): CacheEntry | undefined {
    if (!this.enabled) return undefined;
    return this.entries.get(key);
  }

  put(key: string, model: ModelRef, summary: string): void {
    if (!this.enabled || !this.file) return;
    this.entries.set(key, { hash: key, model, summary, at: new Date().toISOString() });
    const file = this.file;
    const payload = JSON.stringify({ version: 1, entries: [...this.entries.values()].slice(-100) }, null, 2);
    const op = this.writeChain.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, payload, "utf-8");
    });
    this.writeChain = op.catch(() => {});
    void op;
  }

  get enabledFlag(): boolean {
    return this.enabled;
  }
}

/** Decide whether a separate vision model must be used for this round. */
export function shouldHandOffVision(args: {
  visionRequired: boolean;
  forceHandoff: boolean;
  sessionHasVision: boolean;
  imagesPresent: boolean;
}): { handoff: boolean; reason: string } {
  if (!args.visionRequired && !args.imagesPresent) return { handoff: false, reason: "no visual work detected" };
  if (!args.imagesPresent) return { handoff: false, reason: "visual work detected but no image was supplied" };
  if (args.forceHandoff)
    return {
      handoff: true,
      reason: "vision.force_handoff is enabled: image judgement always routes to a vision model",
    };
  if (!args.sessionHasVision) return { handoff: true, reason: "the session model cannot accept image input" };
  return { handoff: false, reason: "session model is vision-capable and force handoff is disabled" };
}
