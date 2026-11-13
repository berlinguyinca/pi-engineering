#!/usr/bin/env node
/**
 * Does every path and commit id cited by the trail's state files exist in this repository?
 *
 *     node AUDIT/citation-existence-check.mjs [ref] [--json]
 *
 * WHY. `PLAN-COMPLETION.json` is the file a reader trusts to know what the trail claims, and it cited
 * two things that do not exist: `AUDIT/lineage-allowlist.json` (never committed on any ref -- the
 * tracked file is `AUDIT/lineage-superseded.json`) and `X16/fixtures/manifest.json` (declared as
 * evidence by X15/out-chain; no unit ever wrote it). Both were found by hand on 2026-11-09, one of
 * them inside `X16/logs/12` -- a log written by the unit whose subject was citation integrity.
 * `AUDIT/citation-anchor-check.mjs` cannot see this class: it asks whether a cited LINE says what the
 * prose claims, and a citation to a file that was never born has no line to check.
 *
 * WHAT IT CHECKS, per file (tokens are read from the JSON string values for .json files, not from raw
 * text, so escaped quotes and newlines inside strings do not defeat the matchers):
 *   - every path token rooted at a repository top-level directory (`src/`, `test/`, `docs/`, ...) --
 *     must be tracked at `ref`, or a tracked directory;
 *   - every spec-relative token (`AUDIT/x.json`, `templates/x.json`, `manifests/x.json`,
 *     `logs/NN`) -- must resolve under the trail directory or one of its unit directories;
 *   - every unit-relative token (`X16/logs/12`, `E02/E02.handoff.json`, `X16/fixtures/manifest.json`
 *     bare) -- the trail's usual spelling -- must resolve under that unit's directory; the unit set is
 *     measured from the tree at `ref`, not guessed;
 *   - every commit id: full 40-hex tokens must resolve as objects at `ref`; short ids (8-39 hex) are
 *     resolved by git's prefix rules and must name a commit.
 *
 * WHAT IT DELIBERATELY DOES NOT CALL A DEFECT, and why (each exception carries the sentence that makes
 * it a correction, not a suppression):
 *   - 64-hex tokens: `sha256:` content hashes of records, never git objects;
 *   - `KNOWN_CROSS_REPO`: pointers to another repository, which cannot resolve here by construction
 *     and are declared in `AUDIT/lineage-superseded.json` as `unresolvable`;
 *   - `NAMED_AS_ABSENT`: paths cited precisely because they are gone, or never existed. The guard
 *     below re-checks each entry against the tree: if the "known-gone" file is committed, the entry
 *     is a failure, not an exception.
 *   - `DECLARED_GONE`: commit ids cited in the trail's historical prose whose objects a fresh clone
 *     cannot have -- reachable from no ref and in no ref's history. Each entry is a correction with
 *     its reason, and the guard re-checks reachability: if the commit becomes resolvable, the entry
 *     is a failure, not an exception.
 *
 * RESOLUTION DOMAIN: a commit id must resolve against the commits a READER of this ref could get --
 * every ref plus the ref under audit's own history -- not against this checkout's object store.
 * The store holds unreachable objects (squashed-away merge commits, stashes, pruned history), and
 * a prefix that matches one of them passes `git cat-file -e` here while failing on any clone.
 * CI caught the first instance of that gap the day this gate merged: two 8-hex prefixes passed
 * locally and failed on a clean clone. An 8-39 hex prefix resolves only when it is unique among
 * the reachable commits (git's own ambiguity rule, applied to the reader's domain).
 *
 * KNOWN LIMITS, stated because the RESULT line would otherwise overclaim:
 *   - existence is not truth. `RESULT ok` means every extracted token resolves; it never means the
 *     prose about the file is right. That is `citation-anchor-check`'s question.
 *   - tokens it does not extract: paths containing spaces (none in the trail), bare filenames with no
 *     directory, and hex runs shorter than 8.
 *   - a `NAMED_AS_ABSENT` entry is token-scoped, so prose that newly asserts the file exists in a
 *     different sentence is masked; the entries exist to make corrections, and each names the file.
 *
 * Exit status: 1 if any citation dangles.
 */
import { execFileSync } from "node:child_process";

const SPEC = "docs/specs/harness-reliability-bootstrap-20261103";
const FILES = [`${SPEC}/PLAN-COMPLETION.json`, `${SPEC}/RELEASE-REVIEW.md`];
const TOP = ["src", "test", "docs", "scripts", "templates", "deploy", "extensions", "manifests", ".github", ".woodpecker"];
// `logs` is deliberately not in RELATIVE: a bare `logs/04` in the trail names the current unit's log
// (context carries the unit), so as a path it is a reference, not a citation. Unit-qualified forms
// (`X09/logs/04`) are checked by the unit extractor below.
const RELATIVE = ["AUDIT", "templates", "manifests"];

const KNOWN_CROSS_REPO = new Map([
  ["591264f9bd4fc2fc07d88d94febde4cd0e919448", "tip of berlinguyinca/herdr-engineering (PLAN-COMPLETION.json cross_repo_integration, repo=berlinguyinca/herdr-engineering); declared unresolvable in lineage-superseded.json"],
]);
// Commit ids cited in the trail's historical prose whose objects a fresh clone cannot have.
// Keyed by the cited token (the trail abbreviates), each a correction with its reason.
const DECLARED_GONE = new Map([
  ["fe83bd89", "the pre-squash X12 evidence commit (2026-11-06); its squash, 9fa508c5, is on main under the same subject. PLAN-COMPLETION.json cites the 8-hex prefix in X12's historical measurement ('verify-handoff-trail.ts still reports 35 issues at fe83bd89'); the object survives only in the store of the checkout that ran X12"],
  ["4e011af4", "the X16-era UNCOVERED finding: a commit whose object was unreachable from every ref (for-each-ref --contains count 0). RELEASE-REVIEW.md's history section cites the 8-hex prefix; the object no longer exists in a fresh clone's store. (In this checkout the same prefix happens to match an unrelated stash object -- which is exactly why resolution runs over the ref domain, not the object store.)"],
]);
const NAMED_AS_ABSENT = new Map([
  [".github/workflows/ci.yml", "removed by 85b1b064 when .woodpecker/ci.yaml replaced it; cited as the file that was removed"],
  ["AUDIT/lineage-allowlist.json", "never committed on any ref (git log --all --diff-filter=A finds no addition); the tracked file is AUDIT/lineage-superseded.json. PLAN-COMPLETION.json's caveat and RELEASE-REVIEW.md name it to say it does not exist, so the citation is the correction."],
  ["X08/logs/20", "a citation whose subject is the citation: PLAN-COMPLETION.json's caveat records that an earlier unit cited this log for the branch-only-failure attribution and no such log exists (X08/logs ends at 19; the attribution is produced in X09/logs/04 and X10/logs/01). If a 20th log is ever added, the guard below turns this entry into a failure."],
]);

const ref = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "HEAD";
const asJson = process.argv.includes("--json");
const git = (...a) => { try { return execFileSync("git", ["-c", "core.quotePath=false", ...a], { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
if (git("rev-parse", "--git-dir") === null) { console.error("not a git repository: run this from inside the repository"); process.exit(2); }
if (git("rev-parse", "--verify", ref) === null) { console.error(`ref not found: ${ref}`); process.exit(2); }
const trackedList = (git("ls-tree", "-r", "--name-only", ref) ?? "").split("\n").filter(Boolean);
const tracked = new Set(trackedList);
const trackedDirs = new Set(trackedList.flatMap((p) => { const q = p.split("/"); q.pop(); const acc = []; while (q.length) { acc.push(q.join("/")); q.pop(); } return acc; }));
// The trail's unit set, measured from the tree at `ref`: the directories one level under the spec.
// Unit-relative tokens (`X16/logs/12`) resolve only against this set, never against any directory.
const units = new Set(trackedList.map((p) => p.split("/")).filter((q) => q[0] === "docs" && q[1] === "specs" && q[2] === SPEC.split("/")[2]).map((q) => q[3]).filter(Boolean));
// The commits a reader of `ref` could get: every ref (what a clone fetches) plus the ref under
// audit's own history (a PR head whose branch a clone of the base does not hold).
const reachable = new Set(
  [...(git("rev-list", "--no-object-names", "--all") ?? "").split("\n"),
    ...(git("rev-list", "--no-object-names", ref) ?? "").split("\n")].filter(Boolean));
const objectCache = new Map();
const isCommitByPrefix = (tok) => {
  if (!objectCache.has("c:" + tok)) {
    let n = 0;
    for (const s of reachable) if (s.startsWith(tok)) { n++; if (n > 1) break; }
    objectCache.set("c:" + tok, n === 1);
  }
  return objectCache.get("c:" + tok);
};
const declaredGoneFinding = (file, tok) => {
  if (isCommitByPrefix(tok)) findings.push({ file, kind: "DECLARED_GONE_BUT_REACHABLE", token: tok, why: DECLARED_GONE.get(tok) });
};

const isTrackedPath = (p) => tracked.has(p) || trackedDirs.has(p) || trackedList.some((t) => t.startsWith(p + "/"));
// Spec-relative: exactly the trail directory or one of its unit directories. No repository-wide
// leaf-name fallback -- that let any `.../AUDIT/<leaf>` in the repo silence a real miss.
const resolvesSpecRelative = (tok) => isTrackedPath(`${SPEC}/${tok}`) || [...units].some((u) => isTrackedPath(`${SPEC}/${u}/${tok}`));

const findings = [];
const counts = { top: 0, relative: 0, unit: 0, hex40: 0, hexShort: 0, hex64: 0, crossRepo: 0, absent: 0, declaredGone: 0 };
for (const file of FILES) {
  const raw = git("show", `${ref}:${file}`);
  if (raw === null) { findings.push({ file, kind: "STATE_FILE_UNTRACKED", token: file }); continue; }
  // String values, not raw bytes: a .json citation survives escaped quotes and newlines.
  const strings = file.endsWith(".json")
    ? JSON.stringify(JSON.parse(raw)).match(/"[^"]*"/g) ?? []
    : [raw];
  const text = strings.join("\n");
  const tokenSet = (re) => new Set([...text.matchAll(re)].map((m) => m[0]));

  for (const tok of tokenSet(new RegExp(`(?<![\\w/.-])((?:${TOP.join("|")})/[\\w./-]*[\\w-])`, "g"))) {
    counts.top++;
    if (NAMED_AS_ABSENT.has(tok)) { counts.absent++; continue; }
    if (!isTrackedPath(tok) && !resolvesSpecRelative(tok)) findings.push({ file, kind: "PATH_UNTRACKED", token: tok });
  }
  for (const tok of tokenSet(new RegExp(`(?<![\\w/.-])((?:${RELATIVE.join("|")})/[\\w.-]*[\\w-])`, "g"))) {
    if (tok.startsWith(`${SPEC}/`)) continue;
    counts.relative++;
    if (NAMED_AS_ABSENT.has(tok)) { counts.absent++; continue; }
    if (!resolvesSpecRelative(tok)) findings.push({ file, kind: "RELATIVE_UNRESOLVED", token: tok });
  }
  // A unit-relative citation is either a file (`X16/fixtures/manifest.json`) or a numbered log
  // (`X16/logs/04`); the unit must be one that exists at `ref`, so a citation to a deleted or
  // misspelled unit is a miss, and a token whose unit does not exist is one too. A numbered log
  // resolves to the log's real file, which carries a name suffix (`X16/logs/04-closing-state.txt`);
  // citing the number is how the trail writes it.
  const unitAlt = [...units].sort().join("|");
  const unitRe = new RegExp("(?<![\\w/.-])(?:" + unitAlt + ")/(?:logs/\\d{2}(?![\\d])|[^\\s\"'`]+?\\.(?:json|md|txt|mjs|mts|ts|sh|yml))", "g");
  for (const tok of tokenSet(unitRe)) {
    if (tok.startsWith(`${SPEC}/`)) continue;
    counts.unit++;
    if (NAMED_AS_ABSENT.has(tok)) { counts.absent++; continue; }
    const isNumberedLog = /\/logs\/\d{2}$/.test(tok);
    const unit = tok.split("/")[0];
    const resolved = isNumberedLog
      ? (trackedList.some((t) => t === `${SPEC}/${unit}/logs/${tok.split("/")[2]}`) || trackedList.some((t) => t.startsWith(`${SPEC}/${unit}/logs/${tok.split("/")[2]}-`)))
      : resolvesSpecRelative(tok);
    if (!resolved) findings.push({ file, kind: "UNIT_RELATIVE_UNRESOLVED", token: tok });
  }
  for (const tok of tokenSet(/(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/g)) {
    counts.hex40++;
    if (KNOWN_CROSS_REPO.has(tok)) { counts.crossRepo++; continue; }
    if (DECLARED_GONE.has(tok)) { counts.declaredGone++; declaredGoneFinding(file, tok); continue; }
    if (!reachable.has(tok)) findings.push({ file, kind: "COMMIT_UNRESOLVED", token: tok });
  }
  for (const m of text.matchAll(/(?<![0-9a-f])[0-9a-f]{8,39}(?![0-9a-f])/g)) {
    const tok = m[0];
    // Not commit ids, measured in the trail's own files: dates and numeric ids are all-digit runs
    // (20261109, issuecomment numbers), and a prefix followed by an ellipsis or preceded by
    // `sha256:` is a content-hash prefix (the trail abbreviates handoff hashes that way). Both would
    // otherwise fail prefix resolution and train the reader to ignore this check.
    if (/^\d+$/.test(tok)) continue;
    const after = text.slice(m.index + tok.length, m.index + tok.length + 4);
    if (after.startsWith("…") || after.startsWith("...") || after.startsWith("..")) continue;
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    if (before.endsWith("sha256:")) continue;
    counts.hexShort++;
    if (DECLARED_GONE.has(tok)) { counts.declaredGone++; declaredGoneFinding(file, tok); continue; }
    if (!isCommitByPrefix(tok)) findings.push({ file, kind: "SHORT_COMMIT_UNRESOLVED", token: tok });
  }
  counts.hex64 += tokenSet(/(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g).size;
  // The known-gone entries are only an exception while the file really is gone. A numbered log is
  // "present" once any `<unit>/logs/NN-*` exists, so the guard uses the same resolution as above.
  for (const [tok] of NAMED_AS_ABSENT) if (text.includes(tok)) {
    counts.absent++;
    const m = /^(.+)\/logs\/(\d{2})$/.exec(tok);
    const present = m
      ? (trackedList.includes(`${SPEC}/${tok}`) || trackedList.some((t) => t.startsWith(`${SPEC}/${m[1]}/logs/${m[2]}-`)))
      : (isTrackedPath(tok) || resolvesSpecRelative(tok));
    if (present) findings.push({ file, kind: "NAMED_ABSENT_BUT_PRESENT", token: tok, why: NAMED_AS_ABSENT.get(tok) });
  }
}

if (asJson) console.log(JSON.stringify({ ref, counts, findings }, null, 2));
else {
  console.log(`ref=${ref} files=${FILES.length} top-level-paths=${counts.top} spec-relative=${counts.relative} unit-relative=${counts.unit} full-commit-ids=${counts.hex40} short-commit-ids=${counts.hexShort} sha256-tokens=${counts.hex64} (skipped) cross-repo=${counts.crossRepo} named-absent=${counts.absent} declared-gone=${counts.declaredGone}`);
  for (const f of findings) console.log(`  ${f.kind.padEnd(24)} ${f.file.replace(SPEC + "/", "")} :: ${f.token}`);
  console.log(findings.length
    ? `RESULT FAIL (${findings.length} dangling citation${findings.length === 1 ? "" : "s"})`
    : `RESULT ok: every extracted path and commit id in ${FILES.map((f) => f.split("/").pop()).join(", ")} resolves at ${ref} -- existence only; anchor-check asks whether the cited line says what the prose claims, and this gate does not extract bare filenames, paths with spaces, or hex runs under 8`);
}
process.exit(findings.length ? 1 : 0);
