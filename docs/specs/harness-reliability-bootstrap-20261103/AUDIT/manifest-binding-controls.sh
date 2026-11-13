#!/usr/bin/env bash
# Controls for AUDIT/manifest-binding-scan.mjs: does the gate actually DETECT, or only pass?
#
#   bash docs/specs/harness-reliability-bootstrap-20261103/AUDIT/manifest-binding-controls.sh
#
# A gate's exit status is evidence only if it would have been nonzero had the tree been wrong, and
# this trail has been burned exactly once on a controls script that exited 0 whatever the scanner
# found (X16/logs/16, finding F7). So every case here declares the exit class it expects AND a marker
# the gate must print, and the script exits 1 if any case behaves otherwise. The clean baseline is one
# case among them, not the whole script.
#
# Every case mutates a throwaway worktree of BASE (default HEAD), never the checkout you are standing
# in, and puts the tree back before the next case. Set PROBE=/some/dir to reuse a directory.
#
# WHY THE BREAKS ARE COMMITTED. This gate audits the REF -- `ls-tree <ref>` plus
# `git show <ref>:./path`, exactly as AUDIT/record-reproducibility.mjs does -- so that an uncommitted
# scratch edit cannot be certified as though it were merged. A controls script that edited the working
# tree and expected detection would be testing something the gate deliberately does not look at, and
# the first version of this file did exactly that: three cases read as missed detections when the gate
# was correct to ignore them. So each break is committed in the probe, and undone with a reset. The
# declaration file is the one input read from disk (its header says why), so those cases mutate it
# without committing -- which keeps the two read paths visibly distinct.
set -u
REPO=${REPO:-$(git rev-parse --show-toplevel)}
R=docs/specs/harness-reliability-bootstrap-20261103
GATE=$R/AUDIT/manifest-binding-scan.mjs
DECL=$R/AUDIT/manifest-binding-declared.json
BASE=${BASE:-HEAD}
PROBE_GIVEN=${PROBE:-}
if [ -n "$PROBE_GIVEN" ]; then PROBE=$PROBE_GIVEN; rm -rf "$PROBE"
else PROBE=$(cd "$(mktemp -d /tmp/mbind-controls-XXXXXX)" && pwd -P); rmdir "$PROBE"; fi

cd "$REPO" || exit 1
git worktree prune
git worktree add --detach -f -q "$PROBE" "$BASE" || { echo "FATAL: cannot create a worktree at $PROBE"; exit 1; }
cd "$PROBE" || { echo "FATAL: cannot enter $PROBE -- refusing to run controls anywhere else"; exit 1; }
PROBE=$(pwd -P)
TOP=$(git rev-parse --show-toplevel)
if [ "$TOP" != "$PROBE" ]; then echo "FATAL: $PROBE resolves to $TOP -- the probe is not a separate tree, refusing to mutate it."; exit 1; fi

GATECMD="node $GATE"
LAST_OUT=/tmp/mbind-last.out
FAILURES=0
expect_failed() { echo "EXPECTATION-FAILED: $1"; FAILURES=1; }
run() { $GATECMD > "$LAST_OUT" 2>&1; LAST_RC=$?; }
# check <case> <ok|fail|exit2> <marker-regex>
check() {
  local case="$1" expect="$2" marker="${3:-}"
  if [ "$expect" = "ok" ] && [ "$LAST_RC" -ne 0 ]; then expect_failed "$case: expected exit 0, got $LAST_RC"; return; fi
  if [ "$expect" = "fail" ] && [ "$LAST_RC" -eq 0 ]; then expect_failed "$case: expected a nonzero exit, got 0"; return; fi
  if [ "$expect" = "exit2" ] && [ "$LAST_RC" -ne 2 ]; then expect_failed "$case: expected exit 2, got $LAST_RC"; return; fi
  if [ -n "$marker" ] && ! grep -qE "$marker" "$LAST_OUT"; then
    expect_failed "$case: expected output to match /$marker/"
    sed -n '1,4p' "$LAST_OUT" | sed 's/^/    got: /'
  fi
}
# replace <file> <old> <new> -- one exact string replacement, so only the intended bytes change.
# Re-serialising the JSON would rewrite every byte of the file and confound the result.
replace() {
  node -e '
    const fs = require("fs");
    const [f, o, n] = [process.argv[1], process.argv[2], process.argv[3]];
    const s = fs.readFileSync(f, "utf8");
    if (s.split(o).length - 1 !== 1) { console.error(`replace: ${f} matches ${JSON.stringify(o).slice(0,60)} ${s.split(o).length - 1} times, expected exactly 1`); process.exit(3); }
    fs.writeFileSync(f, s.replace(o, n));
  ' "$1" "$2" "$3" || { echo "FATAL: replacement failed"; exit 1; }
}
# break <file> <old> <new> -- replace, then commit, so the audited ref contains the break.
break_() {
  replace "$1" "$2" "$3"
  commit_break
}
commit_break() { git -C "$PROBE" add -A >/dev/null && git -C "$PROBE" -c commit.gpgsign=false commit -q -m "probe: deliberate break" || { echo "FATAL: cannot commit the probe break"; exit 1; }; }
undo() { git -C "$PROBE" reset --hard -q HEAD~1 >/dev/null && git -C "$PROBE" clean -qfd; }
# Declaration cases: mutate on disk, restore from the index. No commit -- see the header.
restore_decl() { git -C "$PROBE" checkout -q -- "$DECL"; }
line() { echo; echo "=================================================================="; echo "$*"; echo "=================================================================="; }

echo "MANIFEST-BINDING CONTROLS. Probe worktree: $PROBE at $(git -C "$PROBE" log --format='%h %s' -1)"
echo "Each case declares the verdict it expects; this script exits 0 only if every case behaves."

line "M0  baseline: an untouched tree certifies ok"
run; tail -1 "$LAST_OUT"
check M0-baseline ok 'RESULT ok'

line "M1  a record's authority is replaced with a value its manifest does not produce"
# X14/out-chain conforms today; corrupting it must be caught, not excused by any declaration.
break_ "$R/X14/out-chain/X14.handoff.json" '"taskAuthorityHash": "sha256:' '"taskAuthorityHash": "sha256:000000000000000000000000000000000000000000000000000000000000000'
run; grep -E 'AUTHORITY-MISMATCH|^RESULT' "$LAST_OUT" | head -3
check M1-authority-corrupted fail 'AUTHORITY-MISMATCH.*X14/out-chain/X14.handoff.json'
undo

line "M2  a manifest's parent hash names nothing"
break_ "$R/X15/fixtures/manifest.json" '"parentHandoffHash": "sha256:' '"parentHandoffHash": "sha256:111111111111111111111111111111111111111111111111111111111111111'
run; grep -E 'PARENT-UNRESOLVED|^RESULT' "$LAST_OUT" | head -3
check M2-parent-unresolved fail 'PARENT-UNRESOLVED.*X15/fixtures/manifest.json'
undo

line "M3  a manifest's parent hash names a real record -- the wrong one"
# X15 adopts X14's parent. That record exists and is tracked, so only the commit edge can expose it:
# it declares a forward edge to X14, not to X15.
NEWPARENT=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).parentHandoffHash)' "$R/X14/fixtures/manifest.json")
OLDPARENT=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).parentHandoffHash)' "$R/X15/fixtures/manifest.json")
break_ "$R/X15/fixtures/manifest.json" "\"parentHandoffHash\": \"$OLDPARENT\"" "\"parentHandoffHash\": \"$NEWPARENT\""
run; grep -E 'EDGE-WRONG|PARENT-AMBIGUOUS|^RESULT' "$LAST_OUT" | head -3
check M3-parent-wrong-record fail 'EDGE-WRONG.*X15/fixtures/manifest.json'
undo

line "M4  a manifest describes a different task than the record it belongs to"
break_ "$R/X15/fixtures/manifest.json" '"taskId": "X15"' '"taskId": "X99"'
run; grep -E 'UNIT-DISAGREE|^RESULT' "$LAST_OUT" | head -3
check M4-manifest-disagrees fail 'UNIT-DISAGREE.*X15/fixtures/manifest.json'
undo

line "M5  a manifest the real parser would reject"
# The gate reimplements parseTaskManifest, so a manifest only it can read must be an offence, not a
# pass. An unknown top-level key is what the parser rejects and what the pin test covers.
break_ "$R/X15/fixtures/manifest.json" '"taskId": "X15",' '"taskId": "X15", "surprise": 1,'
run; grep -E 'UNPARSEABLE|^RESULT' "$LAST_OUT" | head -3
check M5-unparseable fail 'UNPARSEABLE.*X15/fixtures/manifest.json'
undo

line "M6  a declaration is deleted: the deviation it excused goes red again"
# This is the case that makes the declaration file load-bearing rather than decorative: removing one
# entry must cost exactly the offence it declared.
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const before = d.entries.length;
  d.entries = d.entries.filter((e) => e.record !== "X15/out/X15.handoff.json");
  if (d.entries.length !== before - 1) { console.error("expected to remove exactly one entry"); process.exit(3); }
  fs.writeFileSync(process.argv[1], JSON.stringify(d, null, 2) + "\n");
' "$DECL"
run; grep -E 'AUTHORITY-MISMATCH|^RESULT' "$LAST_OUT" | head -3
check M6-declaration-removed fail 'AUTHORITY-MISMATCH.*X15/out/X15.handoff.json'
restore_decl

line "M7  a declaration whose observed value no longer matches the record"
replace "$DECL" '"observed": "sha256:9766e2fb5a7ad9cc8cc855cfc226f9d997becd1328ffc6b9aef9cc2de6ec84f6",
      "annotatedBy": "b0a2cf0e' '"observed": "sha256:9999e2fb5a7ad9cc8cc855cfc226f9d997becd1328ffc6b9aef9cc2de6ec84f6",
      "annotatedBy": "b0a2cf0e'
run; grep -E 'STALE|^RESULT' "$LAST_OUT" | head -3
check M7-declaration-stale fail 'STALE.*X15/out/X15.handoff.json'
restore_decl

line "M8  a declaration pointing its annotatedBy at a commit that is not reachable"
replace "$DECL" '"annotatedBy": "b0a2cf0eeb84062210d5965f2c71a6c55e0f3e41"' '"annotatedBy": "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"'
run; grep -E 'BAD-DECLARATION|^RESULT' "$LAST_OUT" | head -3
check M8-annotatedby-unreachable fail 'BAD-DECLARATION.*annotatedBy deadbeef'
restore_decl

line "M9  a declaration whose annotatedBy is reachable but does not carry the file it annotates"
# The repository's first commit is reachable from HEAD and carries none of the trail's records.
FIRST=$(git rev-list --max-parents=0 HEAD | head -1)
replace "$DECL" '"annotatedBy": "b0a2cf0eeb84062210d5965f2c71a6c55e0f3e41"' "\"annotatedBy\": \"$FIRST\""
run; grep -E 'BAD-DECLARATION|^RESULT' "$LAST_OUT" | head -3
check M9-annotatedby-wrong-commit fail 'BAD-DECLARATION.*does not carry'
restore_decl

line "M10 a declaration for a record that has no deviation"
node -e '
  const fs = require("fs");
  const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  d.entries.push({
    record: "X14/out-chain/X14.handoff.json",
    kind: "authority_raw",
    observed: JSON.parse(fs.readFileSync("docs/specs/harness-reliability-bootstrap-20261103/X14/out-chain/X14.handoff.json", "utf8")).taskAuthorityHash,
    annotatedBy: "b0a2cf0eeb84062210d5965f2c71a6c55e0f3e41",
    why: "deliberately false: X14/out-chain conforms, so nothing needs declaring here",
  });
  fs.writeFileSync(process.argv[1], JSON.stringify(d, null, 2) + "\n");
' "$DECL"
run; grep -E 'DECL-GONE|^RESULT' "$LAST_OUT" | head -3
check M10-declaration-unneeded fail 'DECL-GONE.*X14/out-chain/X14.handoff.json'
restore_decl

line "M11 the declaration file is not readable"
printf 'this is not json' > "$DECL"
run; grep -E 'cannot read' "$LAST_OUT" | head -1
check M11-declaration-unreadable exit2 'cannot read'
restore_decl

line "M12 run from a subdirectory: zero records must not read as a pass"
( cd "$R" && node AUDIT/manifest-binding-scan.mjs > /tmp/mbind-subdir.out 2>&1; echo $? > /tmp/mbind-subdir.rc )
LAST_RC=$(cat /tmp/mbind-subdir.rc); LAST_OUT=/tmp/mbind-subdir.out
grep -E 'RESULT FAIL' "$LAST_OUT" | head -1
check M12-wrong-cwd exit2 'RESULT FAIL.*run this from the repository root'
LAST_OUT=/tmp/mbind-last.out

line "M13 every break undone: the tree certifies ok again, with nothing left behind"
git -C "$PROBE" status --porcelain | head -3
run; tail -1 "$LAST_OUT"
check M13-restored ok 'RESULT ok'
if [ -n "$(git -C "$PROBE" status --porcelain)" ]; then
  expect_failed "M13-restore-clean: the probe tree is not clean after the cases: $(git -C "$PROBE" status --porcelain | head -3 | tr '\n' ' ')"
fi
if [ "$(git -C "$PROBE" rev-parse HEAD)" != "$(git -C "$PROBE" rev-parse "$BASE")" ]; then
  expect_failed "M13-head-moved: the probe is not back at $BASE"
fi

line "M14 the parent's forward edge is carried by a LATER generation, and removing THAT one is caught"
# The regression this exists for: the first version of the gate resolved X08's parent to the record the
# hash names (X07/out, nextTaskId null) and demanded the forward edge from that same record -- reporting
# a false EDGE-ABSENT on a link that X07/out-chain carries (nextTaskId=X08,
# nextBaseSha=45d42acb... == X08.baseSha), exactly as PLAN-COMPLETION.json's
# post_plan_extension.chain_note has recorded since the X-series. Nothing here caught that; the state
# file did. So the case asserts both halves now: the multi-generation shape is NOT an offence (M0 covers
# that), and breaking the generation that actually carries the edge IS.
replace "$R/X07/out-chain/X07.handoff.json" '"nextTaskId": "X08"' '"nextTaskId": null'
replace "$R/X07/out-chain/X07.handoff.json" '"nextBaseSha": "45d42acb70fc2fcac76425d18eb1d651b0e0a9ba"' '"nextBaseSha": null'
commit_break
run; grep -E 'EDGE-ABSENT|^RESULT' "$LAST_OUT" | head -3
check M14-edge-carried-by-later-generation fail 'EDGE-ABSENT.*X08/fixtures/manifest.json.*no generation of X07 declares'
undo

line "M15 back to the untouched tree"
run; tail -1 "$LAST_OUT"
check M15-restored-again ok 'RESULT ok'

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "RESULT ok: every case behaved as declared -- every break detected, every declaration re-verified, the clean tree clean"
else
  echo "RESULT FAIL: one or more cases did not behave as declared"
fi
cd "$REPO" || exit 1
git worktree remove -f "$PROBE" 2>/dev/null || echo "(leave it: $PROBE)"
exit "$FAILURES"
