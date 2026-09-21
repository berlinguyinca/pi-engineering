/**
 * Bounded content views — what the panel shows when a file is opened.
 *
 * Two rules, both about not hurting the session:
 *
 *   1. Nothing is loaded whole. A file or diff is capped by bytes and by lines,
 *      and says so, rather than paging a 40 MB log into a terminal.
 *   2. Nothing throws. An unreadable file or a missing artifact becomes a view
 *      carrying an error, because the panel renders inside Pi's render loop.
 *
 * Artifact bodies read here are for DISPLAY only; they never enter model
 * context as a side effect of being shown.
 */

import { open, stat } from "node:fs/promises";

/** Hard byte cap for a single content read. */
export const MAX_CONTENT_BYTES = 256 * 1024;
/** Hard line cap, applied after decoding. */
export const MAX_CONTENT_LINES = 2000;

export interface ContentView {
  title: string;
  lines: string[];
  truncated: boolean;
  error?: string;
}

/** Split a decoded body into capped lines. */
export function toContentView(title: string, body: string, alreadyTruncated = false): ContentView {
  const raw = body.split("\n");
  // Drop the single trailing empty line a trailing newline produces.
  if (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  const truncated = alreadyTruncated || raw.length > MAX_CONTENT_LINES;
  return {
    title,
    lines: raw.slice(0, MAX_CONTENT_LINES),
    truncated,
  };
}

/**
 * Read a working-tree file, capped at `MAX_CONTENT_BYTES`.
 *
 * An oversized file is truncated rather than refused: seeing the first part of
 * a big file is more useful than an error about its size.
 */
export async function readFileContent(absPath: string, title?: string): Promise<ContentView> {
  const label = title ?? absPath;
  try {
    const info = await stat(absPath);
    if (!info.isFile()) {
      return { title: label, lines: [], truncated: false, error: "not a file" };
    }
    const handle = await open(absPath, "r");
    try {
      const size = Math.min(info.size, MAX_CONTENT_BYTES);
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      return toContentView(label, buffer.toString("utf8"), info.size > MAX_CONTENT_BYTES);
    } finally {
      await handle.close();
    }
  } catch (err) {
    return { title: label, lines: [], truncated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The slice of the repository this module needs. */
export interface CommitReader {
  commitDiff(sha: string): Promise<string>;
}

/**
 * Read the patch a commit introduced, capped like every other content view.
 *
 * The subject goes in the TITLE and the body stays a pure diff, because the
 * renderer decides between "number this as a file" and "number this as a diff"
 * by looking at the body: a `commit …`/`Author: …` preamble makes a patch read
 * as a source file whose first line is a sha.
 */
export async function readCommitContent(repo: CommitReader, sha: string, subject?: string): Promise<ContentView> {
  const label = subject ? `${sha} ${subject}` : sha;
  try {
    const body = await repo.commitDiff(sha);
    if (!body.trim()) {
      // An empty commit, or one whose patch git declines to produce. Saying so
      // beats an empty pane that looks like a failure to load.
      return { title: label, lines: ["  (no textual changes)"], truncated: false };
    }
    if (body.length > MAX_CONTENT_BYTES) return toContentView(label, body.slice(0, MAX_CONTENT_BYTES), true);
    return toContentView(label, body);
  } catch (err) {
    return { title: label, lines: [], truncated: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The slice of the artifact store this module needs. */
export interface ArtifactReader {
  readContentByUri(uri: string): Promise<string | undefined>;
}

/**
 * Read a candidate diff by artifact URI (INV-001: the reference travels, the
 * body is fetched lazily and only for display).
 */
export async function readDiffContent(artifacts: ArtifactReader, uri: string, title?: string): Promise<ContentView> {
  const label = title ?? uri;
  try {
    const body = await artifacts.readContentByUri(uri);
    if (body === undefined) {
      return { title: label, lines: [], truncated: false, error: "artifact not found" };
    }
    if (body.length > MAX_CONTENT_BYTES) {
      return toContentView(label, body.slice(0, MAX_CONTENT_BYTES), true);
    }
    return toContentView(label, body);
  } catch (err) {
    return { title: label, lines: [], truncated: false, error: err instanceof Error ? err.message : String(err) };
  }
}
