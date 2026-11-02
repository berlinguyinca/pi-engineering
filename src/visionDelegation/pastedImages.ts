/**
 * Ruling R18: Pi's TUI paste (Ctrl+V) does not send an image. It writes the clipboard image to
 * `os.tmpdir()/pi-clipboard-<uuid>.<ext>` and inserts that PATH into the editor text. This module finds such
 * paths in the input text and reads them as images, under strict rules so a typed path can never make Pi read
 * an arbitrary file:
 *
 * - the basename must be exactly Pi's clipboard name (uuid, png/jpg/jpeg/gif/webp);
 * - the file's real path must be DIRECTLY inside the real path of `os.tmpdir()`;
 * - it must be a regular file itself (a symlink is rejected even if it points to a file);
 * - its size must be > 0 and <= 20 MiB.
 *
 * Failing the name, location, file-type or existence check means "not an image": the path stays plain text.
 * An empty or oversized clipboard file is reported (`problem`) so the caller can tell the user.
 */

import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname } from "node:path";

export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLIPBOARD_NAME = new RegExp(`^pi-clipboard-${UUID}\\.(png|jpe?g|gif|webp)$`);
/**
 * An absolute path ending in a clipboard name. Before it: start, whitespace, a quote or a backtick (or an
 * opening bracket). After it: end, whitespace, a quote, a backtick, a closing bracket, or sentence punctuation
 * that is itself followed by whitespace or the end (so `x.png.bak` or `x.png/y` never match).
 */
const PASTED_PATH = new RegExp(
  `(?<=^|[\\s"'\`(\\[<])(/(?:[^\\s"'\`]*/)?pi-clipboard-${UUID}\\.(?:png|jpe?g|gif|webp))(?=$|[\\s"'\`)\\]>]|[.,;:!?](?:$|\\s))`,
  "g",
);

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Candidate clipboard paths in `text`, in order of first appearance, deduplicated. Purely textual. */
export function pastedPaths(text: string): string[] {
  if (!text.includes("pi-clipboard-")) return [];
  const out: string[] = [];
  for (const m of text.matchAll(PASTED_PATH)) {
    const p = m[1] as string;
    if (CLIPBOARD_NAME.test(basename(p)) && !out.includes(p)) out.push(p);
  }
  return out;
}

export interface PastedImage {
  path: string;
  data: string;
  mimeType: string;
}

export interface PastedImages {
  images: PastedImage[];
  /** Set when a genuine clipboard file could not be used (empty, too large, unreadable). */
  problem?: string;
}

type One = { image: PastedImage } | { problem: string } | null;

async function readOne(path: string, tmpReal: string): Promise<One> {
  let real: string;
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    real = await realpath(path);
    info = await lstat(path);
  } catch {
    return null; // missing (or the path cannot be resolved): just text
  }
  if (dirname(real) !== tmpReal || !info.isFile() || !CLIPBOARD_NAME.test(basename(real))) return null;
  const name = basename(path);
  if (info.size === 0) return { problem: `the pasted file ${name} is empty` };
  if (info.size > MAX_PASTED_IMAGE_BYTES) return { problem: `the pasted file ${name} is larger than 20 MiB` };
  try {
    const handle = await open(real, "r");
    try {
      const bytes = await handle.readFile();
      if (bytes.length === 0) return { problem: `the pasted file ${name} is empty` };
      if (bytes.length > MAX_PASTED_IMAGE_BYTES) return { problem: `the pasted file ${name} is larger than 20 MiB` };
      const mimeType = MIME[extname(name).toLowerCase()] as string;
      return { image: { path, data: bytes.toString("base64"), mimeType } };
    } finally {
      await handle.close();
    }
  } catch (err) {
    return { problem: `the pasted file ${name} could not be read (${(err as Error).message})` };
  }
}

/** Read the candidate paths that pass every safety check, in order. Stops at the first `problem`. */
export async function readPastedImages(paths: string[]): Promise<PastedImages> {
  if (paths.length === 0) return { images: [] };
  let tmpReal: string;
  try {
    tmpReal = await realpath(tmpdir());
  } catch {
    return { images: [] };
  }
  const images: PastedImage[] = [];
  for (const p of paths) {
    const one = await readOne(p, tmpReal);
    if (!one) continue;
    if ("problem" in one) return { images, problem: one.problem };
    images.push(one.image);
  }
  return { images };
}

/** Replace every occurrence of each accepted path with `[pasted image N]` (N from 1, in the given order). */
export function rewritePastedText(text: string, accepted: string[]): string {
  if (accepted.length === 0) return text;
  return text.replace(PASTED_PATH, (match) => {
    const n = accepted.indexOf(match);
    return n < 0 ? match : `[pasted image ${n + 1}]`;
  });
}
