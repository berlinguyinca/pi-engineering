/**
 * Ruling R18: Pi's TUI paste (Ctrl+V) does not send an image. It writes the clipboard image to
 * `os.tmpdir()/pi-clipboard-<uuid>.<ext>` and inserts that PATH into the editor text. This module finds such
 * paths in the input text and reads them as images, under strict rules so a typed path can never make Pi read
 * an arbitrary file:
 *
 * - the basename must be exactly Pi's clipboard name (uuid, png/jpg/jpeg/gif/webp);
 * - the file's real path must be DIRECTLY inside the real path of `os.tmpdir()`;
 * - it must be a regular file itself (a symlink is rejected even if it points to a file);
 * - its size must be > 0 and <= 20 MiB, enforced on the bytes actually read;
 * - the read goes through a handle opened with O_NOFOLLOW | O_NONBLOCK whose dev/ino match the lstat.
 *
 * Failing the name, location, file-type or existence check means "not an image": the path stays plain text.
 * An empty or oversized clipboard file is reported (`problem`) so the caller can tell the user.
 */

import { constants } from "node:fs";
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

/** The slice of a `FileHandle` the reader uses (injectable for tests). */
export interface PastedFileHandle {
  stat(): Promise<{ isFile(): boolean; size: number; dev: number; ino: number }>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export type OpenPasted = (path: string, flags: number) => Promise<PastedFileHandle>;

/** Read-only, refuse a symlink at the final component (ELOOP), never block on a FIFO or device. */
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
/** Errors from `open` that mean "not a regular file at the final component": treated as plain text. */
const NOT_REGULAR = new Set(["ELOOP", "EMLINK", "ENXIO", "EISDIR", "ENOENT", "ENOTDIR"]);

async function readOne(path: string, tmpReal: string, openFile: OpenPasted): Promise<One> {
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
  const empty = { problem: `the pasted file ${name} is empty` };
  const tooLarge = { problem: `the pasted file ${name} is larger than 20 MiB` };
  if (info.size === 0) return empty;
  if (info.size > MAX_PASTED_IMAGE_BYTES) return tooLarge;

  // The checks above and the read below must concern the SAME file. Open without following a symlink and
  // without blocking, then check the open handle itself. A file that is not regular at open time (a symlink
  // at the final component -> ELOOP, a FIFO or device, gone) is plain text with no notice, like any other
  // non-regular candidate. A regular file whose dev/ino differ from the lstat above was swapped between the
  // check and the open: that is reported (the user did paste something), never silently read.
  let handle: PastedFileHandle;
  try {
    handle = await openFile(real, OPEN_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && NOT_REGULAR.has(code)) return null;
    return { problem: `the pasted file ${name} could not be read (${errMessage(err)})` };
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return null;
    if (st.dev !== info.dev || st.ino !== info.ino) {
      return { problem: `the pasted file ${name} changed while it was being checked` };
    }
    if (st.size === 0) return empty;
    if (st.size > MAX_PASTED_IMAGE_BYTES) return tooLarge;
    // Bounded read: never more than cap + 1 bytes, whatever stat said.
    const buf = Buffer.allocUnsafe(MAX_PASTED_IMAGE_BYTES + 1);
    let total = 0;
    while (total < buf.length) {
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (bytesRead <= 0) break;
      total += bytesRead;
    }
    if (total > MAX_PASTED_IMAGE_BYTES) return tooLarge;
    if (total === 0) return empty;
    const mimeType = MIME[extname(name).toLowerCase()] as string;
    return { image: { path, data: buf.subarray(0, total).toString("base64"), mimeType } };
  } catch (err) {
    return { problem: `the pasted file ${name} could not be read (${errMessage(err)})` };
  } finally {
    await handle.close().catch(() => {});
  }
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Read the candidate paths that pass every safety check, in order. Stops at the first `problem`. */
export async function readPastedImages(paths: string[], io: { open?: OpenPasted } = {}): Promise<PastedImages> {
  const openFile: OpenPasted = io.open ?? ((p, flags) => open(p, flags));
  if (paths.length === 0) return { images: [] };
  let tmpReal: string;
  try {
    tmpReal = await realpath(tmpdir());
  } catch {
    return { images: [] };
  }
  const images: PastedImage[] = [];
  for (const p of paths) {
    let one: One;
    try {
      one = await readOne(p, tmpReal, openFile);
    } catch (err) {
      one = { problem: `the pasted file ${basename(p)} could not be read (${errMessage(err)})` };
    }
    if (!one) continue;
    if ("problem" in one) return { images, problem: one.problem };
    images.push(one.image);
  }
  return { images };
}

/**
 * Replace every occurrence of each accepted path with `[pasted image N]`, N counting from `first` in the given
 * order. Callers that list other images before the pasted ones pass `first` so the numbers match that list.
 */
export function rewritePastedText(text: string, accepted: string[], first = 1): string {
  if (accepted.length === 0) return text;
  return text.replace(PASTED_PATH, (match) => {
    const n = accepted.indexOf(match);
    return n < 0 ? match : `[pasted image ${n + first}]`;
  });
}
