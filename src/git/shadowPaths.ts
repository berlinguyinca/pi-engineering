/**
 * Replacing a shadow git directory with the real directory it stands for, in text `git` produced.
 *
 * Why this is its own module: the replacement is a string operation over untrusted output, and getting it wrong
 * corrupts a path in a way that looks plausible. `safeGit` runs every command against a generated shadow common
 * directory (`GIT_COMMON_DIR`) and gives the caller back the REAL repository, so every path the command printed or
 * wrote has to be translated. Pi records the shadow path as it built it; `git` prints whatever it prints, and the two
 * spellings are not always the same directory name:
 *
 *  - Pi's state directory may be reached through a symlink (`$TMPDIR`, a linked or mounted home), and
 *  - `git` resolves parts of the path it was given, so `/var/x` comes back as `/private/var/x` on macOS.
 *
 * One spelling is then the literal TAIL of the other, and a naive `s.split(shadow).join(real)` rewrites the tail of
 * an already-canonical path: `/private` + `/private/var/…`. That doubled prefix was observed in production-shaped
 * runs and produced `ENOENT` from every `mkdir` under a repository's common directory (locks, worktree
 * administration), because the path it named could not exist.
 *
 * So the rules are: translate both spellings, prefer the longer token at each position, never re-read what was
 * written, and match only at a boundary so a repository path that merely ENDS where a shadow path starts is not
 * touched.
 */

/** Characters that may sit on either side of a path occurrence without belonging to it. */
const PATH_EDGE = new Set(["", "/", " ", "\t", "\n", "\r", "\0", '"', "'", "=", ":", ",", "(", ")", "[", "]", "{", "}"]);

const isBoundary = (char: string): boolean => PATH_EDGE.has(char);

/**
 * The two spellings of one shadow directory: how Pi recorded it, and (when it differs) how the filesystem resolves
 * it. `real` forms are optional because a caller that cannot resolve them (missing directory, no permission) simply
 * has one spelling to translate.
 */
export interface ShadowSpelling {
  /** The shadow root Pi created (recorded spelling). */
  root: string;
  /** `root` with symbolic links resolved, or null/absent when it is the same or cannot be resolved. */
  rootReal?: string | null;
  /** The shadow's generated common directory (recorded spelling). */
  common: string;
  /** `common` with symbolic links resolved, or null/absent when it is the same or cannot be resolved. */
  commonReal?: string | null;
}

/** What the two shadow paths translate to. `rootTo` is null when the root has no real counterpart to name. */
export interface ShadowTargets {
  /** Where `common` points. */
  commonTo: string;
  /** Where `root` points; null leaves it alone. */
  rootTo: string | null;
}

/** Every (spelling -> target) pair worth translating, deduplicated, longest spelling first. */
export function shadowRewrites(spelling: ShadowSpelling, targets: ShadowTargets): readonly { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  const seen = new Set<string>();
  const add = (from: string | undefined | null, to: string | null): void => {
    if (!from || to === null || from === "" || from === to || seen.has(from)) return;
    seen.add(from);
    out.push({ from, to });
  };
  add(spelling.common, targets.commonTo);
  add(spelling.commonReal, targets.commonTo);
  add(spelling.root, targets.rootTo);
  add(spelling.rootReal, targets.rootTo);
  // longest first: `<root>/.git` must translate as the common directory, not as the root with `/.git` left over
  return out.sort((a, b) => b.from.length - a.from.length);
}

/**
 * Translate every shadow path in `s` to the real path it stands for (see the file header for why this is a scan and
 * not a chain of `split().join()` calls). Stable under a second application: the output holds real paths only.
 */
export function unshadowText(s: string, spelling: ShadowSpelling, targets: ShadowTargets): string {
  const rewrites = shadowRewrites(spelling, targets);
  if (rewrites.length === 0 || s.length === 0) return s;
  if (!rewrites.some((r) => s.includes(r.from))) return s;
  let out = "";
  let i = 0;
  scan: while (i < s.length) {
    for (const { from, to } of rewrites) {
      if (!s.startsWith(from, i)) continue;
      const before = (s[i - 1] ?? "") as string;
      if (!isBoundary(before)) continue;
      if (!isBoundary((s[i + from.length] ?? "") as string)) continue;
      // `/a/b` cannot be THIS absolute path: it is the tail of the longer path that precedes it, which is a
      // different directory (and, for the nested spelling, exactly the rewrite that made `/private/private/…`).
      if (before === "/" && from.startsWith("/")) continue;
      out += to;
      i += from.length;
      continue scan;
    }
    out += s[i] as string;
    i++;
  }
  return out;
}

/** Whether text `git` wrote refers to this shadow in either spelling. */
export function mentionsShadow(body: string, spelling: ShadowSpelling): boolean {
  return [spelling.root, spelling.rootReal, spelling.common, spelling.commonReal].some(
    (p) => p !== undefined && p !== null && p !== "" && body.includes(p),
  );
}
