#!/usr/bin/env bash
# X16 controls: what the integrity scan certified before, and what it certifies now, on the same tree.
#
#   bash docs/specs/harness-reliability-bootstrap-20261103/X16/fixtures/x16-controls.sh
#
# It builds a throwaway worktree of the commit you name (default HEAD), so every case runs against a
# checkout that has no empty out* directories left by negative-control runs, and prints both the X15
# scanner's verdict (extracted from git, never edited) and the X16 scanner's verdict for each probe.
# Every probe mutates only the throwaway worktree, puts the bytes back before the next case, and
# leaves the working tree alone (the one shared-repository effect is `git worktree prune`, which
# touches worktree registrations only, never a tree). Set PROBE=/some/dir to reuse a directory
# instead of creating and removing one.
#
# The exit status is evidence. Every case declares what it expects -- the exit class (ok / fail) and
# a marker the scanner must print -- and the script fails (exit 1) if any case does not behave as
# declared. An earlier version printed the cases and exited 0 unconditionally (`set -u` without
# expectation checks), so the exitCode recorded in X16/out/X16.handoff.json was not evidence of
# detection; the independent review of 2026-11-10 (X16/logs/16, finding F7) found that, and this
# version closes it.
#
# Why the worktree and the guard are not optional: an earlier version of this script guarded its
# `worktree add` with a directory-exists test. After a previous run, git keeps the worktree registration
# even once the directory is deleted, so `worktree add` refused, `cd` failed, and every case ran in the
# real checkout -- including C2's `git add -f` of a fabricated record. Each case's undo step restored the
# bytes, so nothing was damaged, but the log it printed described a checkout it had never used. Hence: a
# fresh probe directory each run, a failed `cd` is fatal, and the cases refuse to start unless the tree
# they are standing in is the probe. `git worktree prune` clears registrations whose directories are gone
# (this repository carries several), which touches only git's bookkeeping, never a working tree.
set -u
REPO=${REPO:-$(git rev-parse --show-toplevel)}
R=docs/specs/harness-reliability-bootstrap-20261103
BASE=${BASE:-HEAD}
PROBE_GIVEN=${PROBE:-}
if [ -n "$PROBE_GIVEN" ]; then
  PROBE=$PROBE_GIVEN
  rm -rf "$PROBE"
else
  PROBE=$(cd "$(mktemp -d /tmp/x16-controls-XXXXXX)" && pwd -P)   # canonical, so the guard below compares like for like
  rmdir "$PROBE"
fi
OLD_SCANNER=/tmp/x16-old-scanner.mts
GATE_SRC="$REPO/src/bootstrap/resultGate.ts"

cd "$REPO"
git worktree prune   # clear registrations whose directory is already gone (this repo carries several)
git worktree add --detach -f -q "$PROBE" "$BASE" || { echo "FATAL: cannot create a worktree at $PROBE"; exit 1; }
ln -sfn "$REPO/node_modules" "$PROBE/node_modules"
# The scanner as merged by PR #650, unmodified, reached through git so the comparison cannot drift.
git show 46a7109b:$R/AUDIT/integrity-scan.mjs \
  | sed "s#\.\./\.\./\.\./\.\./src/bootstrap/resultGate.ts#$GATE_SRC#" > "$OLD_SCANNER"

cd "$PROBE" || { echo "FATAL: cannot enter $PROBE -- refusing to run controls anywhere else"; exit 1; }
PROBE=$(pwd -P)
TOP=$(git rev-parse --show-toplevel)
if [ "$TOP" != "$PROBE" ]; then
  echo "FATAL: $PROBE resolves to $TOP -- the probe worktree is not separate, refusing to mutate it."
  exit 1
fi
NEW="npx tsx $R/AUDIT/integrity-scan.mjs"
OLD="npx tsx $OLD_SCANNER"
FAILURES=0
expect_failed() { echo "EXPECTATION-FAILED: $1"; FAILURES=1; }
# check <case> <ok|fail> <marker-regex> -- validates LAST_OUT/LAST_RC from the last scanner run.
# "ok" expects exit 0, "fail" expects nonzero; the marker must appear in the full output.
check() {
  local case="$1" expect="$2" marker="$3"
  if [ "$expect" = "ok" ] && [ "$LAST_RC" -ne 0 ]; then expect_failed "$case: expected exit 0, got $LAST_RC"; return; fi
  if [ "$expect" = "fail" ] && [ "$LAST_RC" -eq 0 ]; then expect_failed "$case: expected a nonzero exit, got 0"; return; fi
  if [ -n "$marker" ] && ! grep -qE "$marker" "$LAST_OUT"; then expect_failed "$case: expected output to match /$marker/"; fi
}
# run <which: new|old> <grep-filter> -- runs that scanner, keeps the full output for check(1),
# and prints the filtered view plus the scanner's own exit status (not the filter's).
run() {
  local which="$1" filter="$2"
  case "$which" in
    new) LAST_OUT=/tmp/x16-new.out; eval "$NEW" > "$LAST_OUT" 2>&1 ;;
    old) LAST_OUT=/tmp/x16-old.out; eval "$OLD" > "$LAST_OUT" 2>&1 ;;
  esac
  LAST_RC=$?
  grep -E "$filter" "$LAST_OUT"
  echo "exit=$LAST_RC"
}
line() { echo; echo "=================================================================="; echo "$*"; echo "=================================================================="; }

echo "X16 CONTROLS. Probe worktree: $PROBE at $(git -C "$PROBE" log --format='%h %s' -1)"
echo "'old' = AUDIT/integrity-scan.mjs as merged at 46a7109b (X15), taken from git. 'new' = the same file"
echo "as committed at BASE, checked out in the probe worktree. Each case mutates the probe tree and puts"
echo "the bytes back before the next, and declares the verdict it expects; the script's own exit status"
echo "is 0 only if every case behaves as declared."

line "C0  baseline: what each scanner certifies about an untouched tree"
echo "\$ $NEW"; run new '^units=|^canonical chain|^canonical records|^payload|^waivers|^  (CHAIN|ORPHAN|UNREAD|STALE|PAYLOAD)|^HASH-OFFENDER|^FIELD-OFFENDER|^ORPHAN-OFFENCE|^SILENT-SKIP|^STALE-|^RESULT'
check C0-baseline-new ok 'RESULT ok: 74 canonical forward links resolved, 1 unnamed'
echo; echo "\$ $OLD"; run old '^units=|^RESULT'
check C0-baseline-old ok 'RESULT ok'
echo
echo "The old scan reads 121 files: everything in a generation directory, including the two"
echo "*.SUPERSEDED-*.json copies in FIX-4A/out and FIX-4B/out, which the new scan does not count as"
echo "records (its generation=119 figure counts only *.handoff.json). The 41 tracked records in"
echo "unit directories and the 68 record-shaped files elsewhere (66 payload fixtures under */fixtures/,"
echo "X08/fixtures/handoff-record.json, FIX-2/fixtures/parent-tampered.json) are never opened by the"
echo "old scan, so its hash_ok and field_ok describe a subset. X16/fixtures/record-census.py is that"
echo "arithmetic on git ls-files."

line "C1  tamper a tracked record that lives outside every generation directory"
echo "flips \"status\": \"PASS\" -> \"FAIL\" in T09/T09.handoff.json -- the corrected unit-directory record"
echo "that T09/out-chain copies, one of the records X15's PR body says are fixed. The old scan never"
echo "opens unit-directory records, so it must miss this; the new scan must flag it."
cp $R/T09/T09.handoff.json /tmp/x16-t09.bak
sed -i '' 's/"status": "PASS"/"status": "FAIL"/' $R/T09/T09.handoff.json
echo "\$ $OLD"; run old '^units=|^RESULT'
check C1-old-misses ok 'RESULT ok'
echo; echo "\$ $NEW"; run new '^units=|^HASH-OFFENDER|^PAYLOAD|^RESULT'
check C1-new-detects fail 'HASH-OFFENDER'
cp /tmp/x16-t09.bak $R/T09/T09.handoff.json

line "C2  satisfy a canonical forward link with a fabricated negative-control record"
echo "adds X08/out-negctl-probe/X08.handoff.json (X08's taskId, a base of 1111..., its own valid hash"
echo "recomputed over those bytes) and re-points X07/out-chain at it, so the real X08/out-chain is named"
echo "by nobody. The two files are then STAGED in this throwaway worktree -- committed bytes are what"
echo "the probe needs, because the old scan's only other sight of a file is its untracked rule, which"
echo "cannot see bytes already in the tree. This is the probe behind review-650 finding P5: run there"
echo "against a commit carrying the fabricated generation, the old scan printed resolved=73 offenders=0"
echo "and RESULT ok. Afterwards the index and the tree are put back."
mkdir -p $R/X08/out-negctl-probe
cp $R/X08/out-chain/X08.handoff.json $R/X08/out-negctl-probe/X08.handoff.json
cp $R/X07/out-chain/X07.handoff.json /tmp/x16-x07.bak
npx tsx "$REPO/$R/X16/fixtures/rehash.mts" $R/X08/out-negctl-probe/X08.handoff.json baseSha=1111111111111111111111111111111111111111
npx tsx "$REPO/$R/X16/fixtures/rehash.mts" $R/X07/out-chain/X07.handoff.json nextBaseSha=1111111111111111111111111111111111111111
git add -f $R/X08/out-negctl-probe/X08.handoff.json $R/X07/out-chain/X07.handoff.json
echo; echo "staged in the probe worktree:"; git diff --cached --name-only -- $R
echo; echo "\$ $OLD"; run old '^units=|^  CHAIN|^RESULT'
check C2-old-misses ok 'RESULT ok'
echo; echo "\$ $NEW"; run new '^units=|^  CHAIN|^ORPHAN-OFFENCE|^RESULT'
check C2-new-detects fail 'ORPHAN-OFFENCE'
git reset -q $R/X07/out-chain/X07.handoff.json $R/X08/out-negctl-probe/X08.handoff.json 2>/dev/null || true
cp /tmp/x16-x07.bak $R/X07/out-chain/X07.handoff.json; rm -rf $R/X08/out-negctl-probe

line "C3  tamper a payload fixture (the pre-hash copy of a unit's record)"
echo "flips status in FIX-1/fixtures/handoff-record.json. It carries no hash, so no hash check can see"
echo "it; the X16 rule is that it must still equal another record of its unit apart from handoffHash."
cp $R/FIX-1/fixtures/handoff-record.json /tmp/x16-f1.bak
sed -i '' 's/"status": "PASS"/"status": "FAIL"/' $R/FIX-1/fixtures/handoff-record.json
echo "\$ $OLD"; run old '^units=|^RESULT'
check C3-old-misses ok 'RESULT ok'
echo; echo "\$ $NEW"; run new 'PAYLOAD|^payload|^RESULT'
check C3-new-detects fail 'PAYLOAD-OFFENCE'
cp /tmp/x16-f1.bak $R/FIX-1/fixtures/handoff-record.json

line "C3b tamper the one fixture that does carry a hash"
cp $R/X08/fixtures/handoff-record.json /tmp/x16-x08f.bak
sed -i '' 's/"status": "PASS"/"status": "FAIL"/' $R/X08/fixtures/handoff-record.json
echo "\$ $OLD"; run old '^units=|^RESULT'
check C3b-old-misses ok 'RESULT ok'
echo; echo "\$ $NEW"; run new 'HASH-OFFENDER|hash_ok|^RESULT'
check C3b-new-detects fail 'HASH-OFFENDER'
cp /tmp/x16-x08f.bak $R/X08/fixtures/handoff-record.json

line "C4a the chain head goes undeclared"
python3 - <<PY
import json; f="$R/AUDIT/chain-declaration.json"; d=json.load(open(f)); d["may_be_unnamed"]=[]
json.dump(d, open(f,"w"), indent=2)
PY
echo "\$ $NEW"; run new 'ORPHAN-OFFENCE|^canonical records|^RESULT'
check C4a fail 'ORPHAN-OFFENCE'
git checkout -- $R/AUDIT/chain-declaration.json 2>/dev/null || true

line "C4b a declaration that stops applying"
python3 - <<PY
import json; f="$R/AUDIT/chain-declaration.json"; d=json.load(open(f))
d["may_be_unnamed"].append({"taskId":"X15","baseSha":"2eee4d1a9592b839f0dd3eb677dd9d7d8ed8d59b","why":"probe"})
json.dump(d, open(f,"w"), indent=2)
PY
echo "\$ $NEW"; run new 'STALE-DECLARATION|^canonical records|^RESULT'
check C4b fail 'STALE-DECLARATION'
git checkout -- $R/AUDIT/chain-declaration.json 2>/dev/null || true

line "C4c the tampered control's waiver is removed -- it must offend, not disappear"
python3 - <<PY
import json; f="$R/AUDIT/chain-declaration.json"; d=json.load(open(f)); d["hash_mismatch_expected"]=[]
json.dump(d, open(f,"w"), indent=2)
PY
echo "\$ $NEW"; run new 'HASH-OFFENDER|parent-tampered|^waivers|^RESULT'
check C4c fail 'HASH-OFFENDER'
git checkout -- $R/AUDIT/chain-declaration.json 2>/dev/null || true

line "C4d a payload-fixture rule that matches nothing"
python3 - <<PY
import json; f="$R/AUDIT/chain-declaration.json"; d=json.load(open(f))
d["payload_fixtures"].append({"suffix":"fixtures/alleged-payload.json","field_absent":"handoffHash","why":"probe"})
json.dump(d, open(f,"w"), indent=2)
PY
echo "\$ $NEW"; run new 'STALE-DECLARATION|^payload|^RESULT'
check C4d fail 'STALE-DECLARATION'
git checkout -- $R/AUDIT/chain-declaration.json 2>/dev/null || true

line "C5 the same committed tree in two checkouts (X14's bug class, unit selection)"
echo "the worktree this session runs in keeps $(find "$REPO/$R" -type d -empty -name 'out*' 2>/dev/null | wc -l | tr -d ' ') empty out* directories on disk;"
echo "this fresh worktree keeps $(find $R -type d -empty -name 'out*' | wc -l | tr -d ' '). git does not track empty directories."
echo "\$ new scanner, this checkout"; run new '^units=|^RESULT'
check C5-new ok '^units=75'
echo "\$ old scanner, this checkout -- X15 made generation selection require a .json in the directory,"
echo "so it says units=75 here too. Before that fix the same bytes gave units=73 in a worktree holding empty"
echo "out* directories and 72 in a fresh archive of the same commit (X14/logs/01-04); this case is the"
echo "regression check for that class."
run old '^units=|^RESULT'
check C5-old ok '^units=75'

line "C6 run from inside the spec directory"
cd $R
echo "\$ old scanner from $(pwd)"; run old '^units=|untracked|^RESULT'
check C6-old-cwd-dependent fail ''
echo; echo "\$ new scanner from $(pwd)"; npx tsx AUDIT/integrity-scan.mjs > /tmp/x16-new.out 2>&1; LAST_RC=$?
grep -E '^units=|^canonical chain|^RESULT' /tmp/x16-new.out; echo "exit=$LAST_RC"
check C6-new ok '^units=75'
cd "$PROBE"

line "C7 a file named like a handoff that does not parse"
cp $R/T09/T09.handoff.json /tmp/x16-t09h.bak
printf '{ "taskId": "T09", ' > $R/T09/T09.handoff.json
echo "\$ $OLD"; run old '^units=|^RESULT'
check C7-old-misses ok 'RESULT ok'
echo; echo "\$ $NEW"; run new 'UNREAD|^RESULT'
check C7-new-detects fail 'UNREAD'
cp /tmp/x16-t09h.bak $R/T09/T09.handoff.json

line "C7b a record inside a generation directory that does not parse"
cp $R/X07/out-chain/X07.handoff.json /tmp/x16-x07c.bak
printf '{"taskId": "X07", ' > $R/X07/out-chain/X07.handoff.json
echo "\$ $NEW"; run new 'UNREAD|^RESULT'
check C7b-new-detects fail 'UNREAD'
cp /tmp/x16-x07c.bak $R/X07/out-chain/X07.handoff.json

line "C8 a tracked record that belongs to no scanned unit (SILENT-SKIP guard)"
echo "renames the unit directory R04 to r04. The unit list is structural (any directory holding a"
echo "generation record), so r04 becomes a unit and R04 stops being one, while git still tracks"
echo "docs/.../R04/out/R04.handoff.json. That mismatch -- tracked record paths belonging to no scanned"
echo "unit -- is what SILENT-SKIP reports. Before X15 the unit list was the name pattern"
echo "^[A-Z]{1,4}-?[0-9]{1,2}\$, and five units whose ids end in a letter (FIX-3B, FIX-3B2, FIX-3C,"
echo "FIX-4A, FIX-4B) were skipped by it without a message (X15/logs/01-scanner-skipped-five-units.txt)."
mv $R/R04 $R/r04
echo "\$ $NEW"; run new 'SILENT-SKIP|^units=|^  CHAIN|^RESULT'
check C8-new-detects fail 'SILENT-SKIP'
echo; echo "\$ $OLD"; run old '^units=|^  CHAIN|^RESULT'
check C8-old-detects-via-chain fail '^  CHAIN'
mv $R/r04 $R/R04

line "C9 restore: the tree is back to the state that passes"
echo "\$ $NEW"; run new '^units=|^canonical chain|^canonical records|^payload|^waivers|^  (CHAIN|ORPHAN|UNREAD|STALE|PAYLOAD)|^HASH-OFFENDER|^FIELD-OFFENDER|^ORPHAN-OFFENCE|^SILENT-SKIP|^STALE-|^RESULT'
check C9-restore ok 'RESULT ok: 74 canonical forward links resolved, 1 unnamed'
echo; echo "probe tree after all cases (nothing should be listed):"
git status --short "$R"
if [ -n "$(git status --short "$R")" ]; then expect_failed "C9: the probe tree is not back to clean"; fi

if [ -z "$PROBE_GIVEN" ]; then
  echo
  echo "removing the throwaway worktree $PROBE"
  cd "$REPO"
  # git registers the path as given (/tmp/...), while pwd -P reports /private/tmp/...; try both forms.
  git worktree remove --force "$PROBE" 2>/dev/null || git worktree remove --force "/private/tmp/$(basename "$PROBE")" 2>/dev/null || \
    echo "(leave it: git worktree remove --force $PROBE)"
fi

echo
if [ "$FAILURES" -ne 0 ]; then
  echo "RESULT FAIL: one or more cases did not behave as declared (see EXPECTATION-FAILED above)"
  exit 1
fi
echo "RESULT ok: every case behaved as declared -- every mutation detected, every restore clean"
exit 0
