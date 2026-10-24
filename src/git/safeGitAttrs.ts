/**
 * Attribute handling for safeGit (T16 round 4).
 *
 * A filter, diff or merge DRIVER runs a command that the config names; which files it applies to is chosen by
 * attributes. Config is allow-listed, but a driver could still be selected by `.gitattributes`, `info/attributes` or
 * a global attributes file for any driver that exists anywhere in the configuration that git ends up reading. So
 * attribute processing is cut off at the source: git runs with `GIT_ATTR_SOURCE` = the empty tree (no
 * `.gitattributes` from the work tree, the index or a tree), `core.attributesFile` = a file Pi generates, and an
 * `info/attributes` Pi generates in the private shadow. Nothing the repository contains can select a driver.
 *
 * What is lost, deliberately: `text`/`eol`/`-text` normalisation from attributes (core.autocrlf and core.eol still
 * apply), `ident`, `export-subst`/`export-ignore` in `git archive`, `working-tree-encoding`, `merge=union` and
 * custom merge/diff drivers, `-diff`/`binary` hints (git falls back to its NUL heuristic), `linguist-*`.
 *
 * What is kept: git-lfs. In operator mode, when the operator's own git config defines `filter.lfs`, the repository's
 * `.gitattributes` files are read BY PI and only lines that select `filter=lfs` are carried over, rewritten to
 * exactly `<pattern> filter=lfs diff=lfs merge=lfs -text`. No other attribute, and no other driver name, survives.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MAX_FILE = 1024 * 1024;
const MAX_PATTERNS = 5000;
const MAX_PATTERN = 1024;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const BAD = /[\x00-\x1f\x7f]/;

/** Split a `.gitattributes` line into its pattern and attribute tokens (quoted patterns supported, no macros). */
function splitLine(line: string): { pattern: string; attrs: string[] } | null {
  const s = line.trim();
  if (s === "" || s.startsWith("#") || s.startsWith("[attr]")) return null;
  let pattern: string;
  let rest: string;
  if (s.startsWith('"')) {
    let i = 1;
    let out = "";
    while (i < s.length && s[i] !== '"') {
      if (s[i] === "\\") {
        const next = s[i + 1];
        if (next !== '"' && next !== "\\") return null; // any other escape: not carried over
        out += next;
        i += 2;
      } else {
        out += s[i];
        i++;
      }
    }
    if (s[i] !== '"') return null;
    pattern = out;
    rest = s.slice(i + 1);
  } else {
    const m = /^(\S+)(.*)$/s.exec(s);
    if (!m) return null;
    pattern = m[1] as string;
    rest = m[2] as string;
  }
  return { pattern, attrs: rest.split(/\s+/).filter(Boolean) };
}

/** Does the last `filter` attribute on this line select lfs? */
function selectsLfs(attrs: readonly string[]): boolean {
  let lfs = false;
  for (const a of attrs) {
    if (a === "filter=lfs") lfs = true;
    else if (a.startsWith("filter=") || a === "-filter" || a === "!filter" || a === "filter") lfs = false;
  }
  return lfs;
}

/** Pure: the generated lines for one `.gitattributes` file that lives in directory `dir` ("" for the work tree root). */
export function lfsLines(text: string, dir: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const parsed = splitLine(raw.replace(/\r$/, ""));
    if (!parsed || !selectsLfs(parsed.attrs)) continue;
    const { pattern } = parsed;
    if (pattern === "" || pattern.length > MAX_PATTERN || BAD.test(pattern) || pattern.startsWith("!")) continue;
    let full = pattern;
    if (dir !== "") {
      const trimmed = pattern.replace(/\/+$/, "");
      full = trimmed.includes("/") ? `${dir}/${pattern.replace(/^\//, "")}` : `${dir}/**/${pattern}`;
    }
    const quoted = /[\s"\\]/.test(full) ? `"${full.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : full;
    out.push(`${quoted} filter=lfs diff=lfs merge=lfs -text`);
    if (out.length >= MAX_PATTERNS) break;
  }
  return out;
}

/**
 * The generated global attributes file text for the given work tree: `relPaths` are the tracked `.gitattributes`
 * files (relative, `/`-separated). A file that is not a regular file, or is too large, contributes nothing.
 */
export function generateLfsAttributes(
  workTree: string,
  relPaths: readonly string[],
): { text: string; patterns: number; uncertain: string[] } {
  const lines: string[] = [];
  const uncertain: string[] = [];
  for (const rel of relPaths) {
    if (rel !== ".gitattributes" && !rel.endsWith("/.gitattributes")) continue;
    const full = join(workTree, rel);
    try {
      const st = lstatSync(full);
      if (!st.isFile()) continue;
      if (st.size > MAX_FILE) {
        uncertain.push(`${rel} is larger than 1 MiB, so it was not read`);
        continue;
      }
      const dir = rel === ".gitattributes" ? "" : rel.slice(0, -"/.gitattributes".length);
      const body = readFileSync(full, "utf8");
      // a macro that sets a filter can switch lfs on for any pattern that names it: not interpreted, so not trusted either
      if (/^\s*\[attr\]\S+.*\bfilter\b/m.test(body))
        uncertain.push(`${rel} defines an [attr] macro that sets a filter`);
      lines.push(...lfsLines(body, dir));
    } catch {
      /* unreadable: contributes nothing */
    }
    if (lines.length >= MAX_PATTERNS) {
      uncertain.push("more than 5000 LFS patterns");
      break;
    }
  }
  return { text: lines.length ? `${lines.join("\n")}\n` : "", patterns: lines.length, uncertain };
}
