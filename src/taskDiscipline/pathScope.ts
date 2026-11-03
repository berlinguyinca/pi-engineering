/**
 * Path canonicalisation for contract scope checks.
 *
 * A path is compared only after `~`, `.`/`..` and symlinks are resolved. A path
 * that cannot be resolved with certainty (unexpanded `$VAR`, command
 * substitution, glob in a write position) is reported as `unresolved` so the
 * caller can fail closed instead of guessing.
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export type Resolved = { ok: true; path: string } | { ok: false; reason: string };

const DYNAMIC = /[$`]|\$\(|<\(|>\(/;

/** realpath of the longest existing ancestor, with the remaining tail re-appended. */
function realpathLoose(abs: string): string {
  let probe = abs;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(basename(probe));
    probe = parent;
  }
  let real: string;
  try {
    real = realpathSync(probe);
  } catch {
    real = probe;
  }
  return tail.length ? join(real, ...tail) : real;
}

export function resolvePath(raw: string, cwd: string, home: string = homedir()): Resolved {
  if (!raw) return { ok: false, reason: "empty path" };
  if (DYNAMIC.test(raw))
    return { ok: false, reason: `path ${JSON.stringify(raw)} contains an unexpanded variable or substitution` };
  let p = raw;
  if (p === "~") p = home;
  else if (p.startsWith("~/")) p = join(home, p.slice(2));
  else if (p.startsWith("~")) return { ok: false, reason: `path ${JSON.stringify(raw)} uses another user's home` };
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  return { ok: true, path: realpathLoose(abs) };
}

export function isWithin(path: string, root: string): boolean {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root;
  return path === r || path.startsWith(r + sep);
}

/** Canonicalise configured roots once (roots may themselves be symlinks, e.g. /tmp). */
export function canonicalRoots(roots: readonly string[], cwd: string, home?: string): string[] {
  const out: string[] = [];
  for (const root of roots) {
    const r = resolvePath(root, cwd, home);
    if (r.ok) out.push(r.path);
  }
  return out;
}

export function withinAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => isWithin(path, root));
}
