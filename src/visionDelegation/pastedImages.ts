/**
 * Ruling R18: Pi's TUI paste (Ctrl+V) does not send an image. It writes the clipboard image to
 * `os.tmpdir()/pi-clipboard-<uuid>.<ext>` and inserts that PATH into the editor text. Ruling R29: inside a
 * herdr pane, HERDR writes the pasted image to `os.tmpdir()/herdr-clipboard-images-<uid>/client-<n>-clipboard-
 * <digits>-<k>.<ext>` and types that PATH. This module finds both families of paths in the input text and reads
 * them as images, under strict rules so a typed path can never make Pi read an arbitrary file:
 *
 * - the basename must be exactly the family's clipboard name (png/jpg/jpeg/gif/webp);
 * - Pi family: the file's real path must be DIRECTLY inside the real path of `os.tmpdir()`;
 * - herdr family: the file's real directory must be DIRECTLY inside the real `os.tmpdir()` and be named
 *   `herdr-clipboard-images-<uid>` for the current uid (no uid, no herdr family); that directory must be a real
 *   directory (not a symlink), owned by the current uid, with no group/other permission bits; the file must be
 *   owned by the current uid;
 * - it must be a regular file itself (a symlink is rejected even if it points to a file);
 * - its size must be > 0 and <= 20 MiB, enforced on the bytes actually read;
 * - the read goes through a handle opened with O_NOFOLLOW | O_NONBLOCK whose dev/ino match the lstat.
 *
 * Failing the name, location, directory, owner, file-type or existence check means "not an image": the path
 * stays plain text. An empty or oversized clipboard file is reported (`problem`) so the caller can tell the user.
 */

import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname } from "node:path";

export const MAX_PASTED_IMAGE_BYTES = 20 * 1024 * 1024;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CLIPBOARD_NAME = new RegExp(`^pi-clipboard-${UUID}\\.(png|jpe?g|gif|webp)$`);
/** herdr's clipboard file name (R29), inside `herdr-clipboard-images-<uid>`. */
const HERDR_NAME = /^client-\d+-clipboard-\d+-\d+\.(png|jpe?g|gif|webp)$/;
const HERDR_DIR_PREFIX = "herdr-clipboard-images-";
const PI_TAIL = `pi-clipboard-${UUID}\\.(?:png|jpe?g|gif|webp)`;
const HERDR_TAIL = `${HERDR_DIR_PREFIX}\\d+/client-\\d+-clipboard-\\d+-\\d+\\.(?:png|jpe?g|gif|webp)`;
/**
 * An absolute path ending in a clipboard name of either family. Before it: start, whitespace, a quote or a
 * backtick (or an opening bracket). After it: end, whitespace, a quote, a backtick, a closing bracket, or
 * sentence punctuation that is itself followed by whitespace or the end (so `x.png.bak` or `x.png/y` never match).
 */
const PASTED_PATH = new RegExp(
  `(?<=^|[\\s"'\`(\\[<])(/(?:[^\\s"'\`]*/)?(?:${PI_TAIL}|${HERDR_TAIL}))(?=$|[\\s"'\`)\\]>]|[.,;:!?](?:$|\\s))`,
  "g",
);

/**
 * Injectable environment (tests use a sandbox). `tmpdir` defaults to the real `os.tmpdir()`, `uid` to
 * `process.getuid()` (`null` or no `getuid` means the herdr family is not recognized), `lstat` to fs's.
 */
export interface PastedEnv {
  tmpdir?: string;
  uid?: number | null;
  lstat?: typeof lstat;
}

function currentUid(env: PastedEnv): number | null {
  if ("uid" in env) return env.uid ?? null;
  return typeof process.getuid === "function" ? process.getuid() : null;
}

const isHerdrPath = (p: string, uid: number | null): boolean =>
  uid !== null && HERDR_NAME.test(basename(p)) && basename(dirname(p)) === `${HERDR_DIR_PREFIX}${uid}`;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Candidate clipboard paths of both families in `text`, in order of first appearance, deduplicated. Textual. */
export function pastedPaths(text: string, env: PastedEnv = {}): string[] {
  if (!text.includes("pi-clipboard-") && !text.includes(HERDR_DIR_PREFIX)) return [];
  const uid = currentUid(env);
  const out: string[] = [];
  for (const m of text.matchAll(PASTED_PATH)) {
    const p = m[1] as string;
    if ((CLIPBOARD_NAME.test(basename(p)) || isHerdrPath(p, uid)) && !out.includes(p)) out.push(p);
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

/**
 * The location rule for `real` (a realpath): Pi family directly in the tmpdir; herdr family in herdr's private
 * per-uid directory directly in the tmpdir, which must be a real directory (the given path's own directory too),
 * owned by `uid`, with no group/other bits, and the file owned by `uid`.
 */
async function placedSafely(
  path: string,
  real: string,
  info: { uid: number },
  tmpReal: string,
  uid: number | null,
  lstatFn: typeof lstat,
): Promise<boolean> {
  if (CLIPBOARD_NAME.test(basename(real))) return dirname(real) === tmpReal;
  if (uid === null || !HERDR_NAME.test(basename(real))) return false;
  const dirReal = dirname(real);
  if (dirname(dirReal) !== tmpReal || basename(dirReal) !== `${HERDR_DIR_PREFIX}${uid}`) return false;
  if (info.uid !== uid) return false;
  try {
    const typed = await lstatFn(dirname(path)); // the directory as typed: a symlink there is rejected
    const dir = await lstatFn(dirReal);
    if (typed.isSymbolicLink() || !typed.isDirectory() || typed.dev !== dir.dev || typed.ino !== dir.ino) {
      return false;
    }
    return dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === uid && (dir.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

async function readOne(
  path: string,
  tmpReal: string,
  openFile: OpenPasted,
  uid: number | null,
  lstatFn: typeof lstat,
): Promise<One> {
  let real: string;
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    real = await realpath(path);
    info = await lstatFn(path);
  } catch {
    return null; // missing (or the path cannot be resolved): just text
  }
  if (!info.isFile() || !(await placedSafely(path, real, info, tmpReal, uid, lstatFn))) return null;
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
export async function readPastedImages(
  paths: string[],
  io: { open?: OpenPasted } & PastedEnv = {},
): Promise<PastedImages> {
  const openFile: OpenPasted = io.open ?? ((p, flags) => open(p, flags));
  const lstatFn = io.lstat ?? lstat;
  const uid = currentUid(io);
  if (paths.length === 0) return { images: [] };
  let tmpReal: string;
  try {
    tmpReal = await realpath(io.tmpdir ?? tmpdir());
  } catch {
    return { images: [] };
  }
  const images: PastedImage[] = [];
  for (const p of paths) {
    let one: One;
    try {
      one = await readOne(p, tmpReal, openFile, uid, lstatFn);
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
