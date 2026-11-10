#!/usr/bin/env node
/**
 * Does every path and commit id cited by the trail's state files exist in this repository?
 *
 *     node AUDIT/citation-existence-check.mjs [ref] [--json]
 *
 * WHY. `PLAN-COMPLETION.json` is the file a reader trusts to know what the trail claims, and it cited
 * two things that do not exist: `AUDIT/lineage-allowlist.json` (never committed on any ref -- the
 * tracked file is `AUDIT/lineage-superseded.json`) and `X16/fixtures/manifest.json` (declared as
 * evidence by X15/out-chain; no unit ever wrote it). Both were found by hand on 2026-11-09, in the
 * same sweep that found them in `X16/logs/12` -- a log written by the unit whose subject was citation
 * integrity. `AUDIT/citation-anchor-check.mjs` cannot see this class: it asks whether a cited LINE
 * says what the prose claims, and a citation to a file that was never born has no line to check.
 *
 * WHAT IT CHECKS, per file:
 *   - every path token rooted at a repository top-level directory (`src/`, `test/`, `docs/`, ...) --
 *     must be tracked at `ref`, or a tracked directory prefix;
 *   - every spec-relative token (`AUDIT/x.json`, `templates/x.json`, `manifests/x.json`, ...) -- the
 *     form the trail's prose uses -- must resolve to a tracked file either at the repository root or
 *     under the spec directory;
 *   - every 40-hex token -- must resolve as a git object at `ref`.
 *
 * WHAT IT DELIBERATELY DOES NOT CALL A DEFECT, and why (each is an exception with a reason, not a
 * suppression -- add one only with a sentence saying what was measured):
 *   - 64-hex tokens: `sha256:` content hashes of records, never git objects;
 *   - `KNOWN_CROSS_REPO` below: pointers to another repository, which cannot resolve here by
 *     construction and are declared in `AUDIT/lineage-superseded.json` as `unresolvable`;
 *   - `NAMED_AS_ABSENT` below: paths the prose cites precisely because they are gone (a file a commit
 *     removed) or because they never existed (a name the trail used and later corrected). A check that
 *     flags those trains readers to ignore the check.
 *
 * THE LIMITATION THAT MATTERS: the gate reads tokens, not intent. It cannot tell "cited as existing"
 * from "cited as the wrong name", so every `NAMED_AS_ABSENT` entry is a place where a real regression
 * -- prose that again asserts the file exists -- would pass. Each entry therefore carries the sentence
 * that makes it a correction, and the honest reading of `RESULT ok` is "no citation dangles except the
 * ones recorded here as known-gone", never "every citation is right".
 *
 * Exit status: 1 if any citation dangles. 0 means "every path and commit id in these files resolves",
 * which says nothing about whether the prose about them is true -- that is anchor-check's question,
 * and neither gate is a substitute for the other.
 */
import { execFileSync } from "node:child_process";

const SPEC = "docs/specs/harness-reliability-bootstrap-20261103";
const FILES = [`${SPEC}/PLAN-COMPLETION.json`, `${SPEC}/RELEASE-REVIEW.md`];
const TOP = ["src", "test", "docs", "scripts", "templates", "deploy", "extensions", "manifests", ".github", ".woodpecker"];
// Relative to the spec directory: how the trail's prose names its own audit artefacts.
const RELATIVE = ["AUDIT", "templates", "manifests", "logs"];

// Pointers into another repository. `git cat-file -e` cannot resolve them here and never will; they
// are declared in AUDIT/lineage-superseded.json (kind=unresolvable) and re-verified by lineage-scan.
const KNOWN_CROSS_REPO = new Map([
  ["591264f9bd4fc2fc07d88d94febde4cd0e919448", "upstream pi repository main tip (PLAN-COMPLETION.json cross_repo_integration.main; declared unresolvable in lineage-superseded.json)"],
]);
// Cited because they are gone. The sentence around each says so; verify with `git log --diff-filter=D`.
const NAMED_AS_ABSENT = new Map([
  [".github/workflows/ci.yml", "removed by 85b1b064 when .woodpecker/ci.yaml replaced it; cited as the file that was removed"],
  ["AUDIT/lineage-allowlist.json", "never committed on any ref (git log --all --diff-filter=A finds no addition); the tracked file is AUDIT/lineage-superseded.json. PLAN-COMPLETION.json's caveat and RELEASE-REVIEW.md name it precisely to say it does not exist, so the citation is the correction. If a future edit drops those two sentences the token disappears with them -- this entry does not keep the wrong name alive."],
]);

const ref = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "HEAD";
const asJson = process.argv.includes("--json");
// stderr is swallowed on purpose: `cat-file -e` on a missing object is an expected answer here, and a
// gate that prints `fatal:` while reporting RESULT ok teaches readers to ignore the output.
const git = (...a) => { try { return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
if (git("rev-parse", "--verify", ref) === null) { console.error(`ref not found: ${ref}`); process.exit(2); }
const trackedList = (git("ls-tree", "-r", "--name-only", ref) || "").split("\n").filter(Boolean);
const tracked = new Set(trackedList);
const trackedDirs = new Set(trackedList.flatMap((p) => { const q = p.split("/"); q.pop(); const acc = []; while (q.length) { acc.push(q.join("/")); q.pop(); } return acc; }));
const objectCache = new Map();
const isObject = (sha) => { if (!objectCache.has(sha)) objectCache.set(sha, git("cat-file", "-e", `${sha}^{object}`) !== null); return objectCache.get(sha); };

const resolvesFull = (p) => tracked.has(p) || trackedDirs.has(p.replace(/\/$/, "")) || [...tracked].some((t) => t.startsWith(p.replace(/\/$/, "") + "/"));
const resolvesRelative = (tok) => {
  if (resolvesFull(tok)) return true;
  // `logs/04` is the trail's shorthand for a numbered log; it names a unit's log directory only when
  // some tracked file `<unit>/logs/04-*.txt` exists, so require that and let the prose be wrong when
  // it does not name one.
  const m = /^logs\/(\d+)$/.exec(tok);
  if (m) return trackedList.some((t) => new RegExp(`/logs/${m[1]}-[^/]*$`).test(t));
  const leaf = tok.split("/").pop();
  return trackedList.some((t) => t === `${SPEC}/${tok}` || t.endsWith(`/${tok}`) || (RELATIVE.includes(tok.split("/")[0]) && t.endsWith("/" + leaf)));
};

const findings = [];
const counts = { full: 0, relative: 0, hex40: 0, hex64: 0, crossRepo: 0, absent: 0 };
for (const file of FILES) {
  const src = git("show", `${ref}:${file}`);
  if (src === null) { findings.push({ file, kind: "STATE_FILE_UNTRACKED", token: file }); continue; }
  for (const tok of new Set([...src.matchAll(new RegExp(`(?<![\\w/.-])((?:${TOP.join("|")})/[\\w./-]*[\\w-])`, "g"))].map((m) => m[1]))) {
    counts.full++;
    if (NAMED_AS_ABSENT.has(tok)) { counts.absent++; continue; }
    // A top-level-looking token may be the spec-relative form the trail's prose uses.
    if (!resolvesFull(tok) && resolvesRelative(tok)) continue;
    if (!resolvesFull(tok)) findings.push({ file, kind: "PATH_UNTRACKED", token: tok });
  }
  for (const tok of new Set([...src.matchAll(new RegExp(`(?<![\\w/.-])((?:${RELATIVE.join("|")})/[\\w./-]*[\\w-])`, "g"))].map((m) => m[1]))) {
    if (tok.startsWith(`${SPEC}/`)) continue;
    counts.relative++;
    if (NAMED_AS_ABSENT.has(tok)) { counts.absent++; continue; }
    if (!resolvesRelative(tok)) findings.push({ file, kind: "RELATIVE_UNRESOLVED", token: tok });
  }
  for (const tok of new Set([...src.matchAll(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g)].map((m) => m[0]))) {
    counts.hex40++;
    if (KNOWN_CROSS_REPO.has(tok)) { counts.crossRepo++; continue; }
    if (!isObject(tok)) findings.push({ file, kind: "COMMIT_UNRESOLVED", token: tok });
  }
  counts.hex64 += new Set([...src.matchAll(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g)].map((m) => m[0])).size;
  for (const [tok, why] of NAMED_AS_ABSENT) if (src.includes(tok)) { counts.absent++; if (isObject(tok)) findings.push({ file, kind: "NAMED_ABSENT_BUT_PRESENT", token: tok, why }); }
}

if (asJson) console.log(JSON.stringify({ ref, counts, findings }, null, 2));
else {
  console.log(`ref=${ref} files=${FILES.length} paths=${counts.full} spec-relative=${counts.relative} commit-ids=${counts.hex40} sha256-tokens=${counts.hex64} (not git objects, skipped) cross-repo=${counts.crossRepo} named-absent=${counts.absent}`);
  for (const f of findings) console.log(`  ${f.kind.padEnd(22)} ${f.file.replace(SPEC + "/", "")} :: ${f.token}`);
  console.log(findings.length ? `RESULT FAIL (${findings.length} dangling citation${findings.length === 1 ? "" : "s"})` : `RESULT ok: every path and commit id cited by ${FILES.map((f) => f.split("/").pop()).join(", ")} resolves at ${ref} (existence only -- anchor-check asks whether the cited line says what the prose claims)`);
}
process.exit(findings.length ? 1 : 0);
