#!/usr/bin/env bash
# X11 negative tests for the `abbreviated` kind added to AUDIT/lineage-scan.mjs.
#
# Why negative tests: a declaration that accepts anything is not a declaration, it is the gate turned
# off. `abbreviated` was added by X11 to describe a real defect (X08/out resultSha stamped as the
# 8-character git abbreviation "9f064450"), so it had to be shown to refuse the things it is supposed
# to refuse. Each case below is COMMITTED in a scratch checkout before being measured -- the scanner
# reads records with `git show <ref>:<path>`, so only a real commit exercises the real code path -- and
# the assertion is the scanner's own verdict plus the reason line it printed.
#
# The scratch checkout shares this repository's object store and refs, so reachability answers are the
# same as on the branch. It is created here (a detached worktree of HEAD under a temp directory) and
# removed on exit, so the command is the same on any machine and the conductor worktree is only read.
#
#   usage: bash X11/fixtures/lineage-negative-tests.sh [conductor-worktree]     (default: this repo)
set -uo pipefail
C=${1:-$(git rev-parse --show-toplevel)}
SPEC=docs/specs/harness-reliability-bootstrap-20261103
REC=$SPEC/X08/out/X08.handoff.json
MAN=$SPEC/AUDIT/lineage-superseded.json
OTHER=b0c0e75ded4778981fa500914debe7aa439a5538
SCRATCH=$(mktemp -d)/lineage-negative-scratch
git -C "$C" worktree add --detach "$SCRATCH" HEAD >/dev/null 2>&1 || { echo "cannot create scratch worktree at $SCRATCH"; exit 70; }
cleanup() { git -C "$C" worktree remove --force "$SCRATCH" 2>/dev/null || rm -rf "$SCRATCH"; git -C "$C" worktree prune 2>/dev/null; }
trap cleanup EXIT
cd "$SCRATCH" || exit 70
git checkout -q --detach "$(git -C "$C" rev-parse HEAD)" 2>/dev/null
git checkout -q -- . 2>/dev/null
cp "$C/$SPEC/AUDIT/lineage-scan.mjs" "$SPEC/AUDIT/lineage-scan.mjs"
cp "$C/$SPEC/AUDIT/lineage-superseded.json" "$SPEC/AUDIT/lineage-superseded.json"
# The declaration and the widened scanner are still uncommitted on the branch at the time these tests
# run, and `restore` below resets to BASE -- so they have to be part of BASE, or every case would
# silently test the branch's pre-X11 scanner against a manifest with no entry.
git add -f "$SPEC/AUDIT/lineage-scan.mjs" "$SPEC/AUDIT/lineage-superseded.json"
git commit -q -m "X11 negative-test baseline: scanner and declaration as they stand in the conductor worktree" 2>/dev/null || true   # no-op once X11's task commit carries them
BASE=$(git rev-parse HEAD)

run() { node "$SPEC/AUDIT/lineage-scan.mjs" 2>&1; }
check() { # $1=label $2=substring that must appear $3=1 if the scanner must exit non-zero, 0 if it must pass
  local out code got hit
  out=$(run); code=$?
  got=$(grep -oE "RESULT (ok|FAIL \([0-9]+\))" <<<"$out" | tail -1)
  hit=no; grep -qF -- "$2" <<<"$out" && hit=yes
  if { { [ "$3" = 1 ] && [ "$code" -ne 0 ]; } || { [ "$3" = 0 ] && [ "$code" -eq 0 ]; }; } && [ "$hit" = yes ]; then
    printf '  PASS  %-44s %-12s matched "%s"\n' "$1" "$got" "$2"
  else
    printf '  FAIL  %-44s %-12s exit=%s matched=%s, wanted "%s"\n' "$1" "$got" "$code" "$hit" "$2"
    sed 's/^/          | /' <<<"$out" | tail -3
  fi
}
restore() { git reset -q --hard "$BASE"; git checkout -q -- . 2>/dev/null; }
edit_entry() { # $1=field $2=value -- rewrite the X08/out resultSha entry in the scratch manifest
  python3 - "$MAN" "$1" "$2" <<'PYEOF'
import json, sys
p, field, val = sys.argv[1], sys.argv[2], sys.argv[3]
m = json.load(open(p))
for e in m["entries"]:
    if e["record"].endswith("X08/out/X08.handoff.json") and e["field"] == "resultSha":
        e[field] = val
json.dump(m, open(p, "w"), indent=2, sort_keys=True)
PYEOF
}

echo "### lineage-scan 'abbreviated' negative tests   scratch=$(git rev-parse --short HEAD)   started=$(date -u +%H:%M:%S)   load=$(sysctl -n vm.loadavg | tr -d '{}')"
echo

# 0. Baseline: the entry as X11 wrote it.
check "0 baseline, entry correct" "RESULT ok" 0

# 1. Take the declaration away. The same pointer must read as an unknown break, not as nothing.
python3 - "$MAN" <<'PYDEL'
import json, sys
p = sys.argv[1]; m = json.load(open(p))
m["entries"] = [e for e in m["entries"] if not (e["record"].endswith("X08/out/X08.handoff.json") and e["field"] == "resultSha")]
m["count"] = len(m["entries"]); json.dump(m, open(p, "w"), indent=2, sort_keys=True)
PYDEL
git commit -qam "negative 1: declaration removed"; check "1 entry removed" "UNCOVERED" 1
restore

# 2. An entry that does not describe what the record actually holds.
edit_entry brokenSha deadbeef
git commit -qam "negative 2: brokenSha rewritten"; check "2 entry disagrees with the record" "STALE" 1
restore

# 3. A live, reachable commit -- simply not the one the abbreviation names.
edit_entry replacement "$OTHER"
git commit -qam "negative 3: replacement is a different live commit"; check "3 replacement is not the named commit" "names 9f0644507e51" 1
restore

# 4. The replacement left abbreviated, which is the defect itself, declared.
edit_entry replacement 9f064450
git commit -qam "negative 4: replacement abbreviated too"; check "4 replacement not in full form" "must carry the replacement in full 40-hex form" 1
restore

# 5. The uniqueness predicate, from both sides of `named.length !== 1`.
#    5a: an abbreviation too short to be one at all (the gate demands 7-39 hex).
#    5b: a 7-hex prefix that names no commit.
#    The ">1 commit" side cannot be produced here and the reason is measured, not assumed: this
#    repository has no duplicate commit prefixes at any length from 7 to 12 --
#      for L in 7..12: git rev-list --all | cut -c1-$L | sort | uniq -d | wc -l   -> 0
#    so every abbreviation a well-formed entry could carry denotes at most one commit. Zero is the
#    reachable failure, and it exercises the same predicate: an entry may not vouch for a guess.
python3 - "$REC" "$MAN" <<'PYAMB'
import json, sys
rec, man = sys.argv[1], sys.argv[2]
r = json.load(open(rec)); r["resultSha"] = "9"; json.dump(r, open(rec, "w"), indent=2, sort_keys=True)
m = json.load(open(man))
for e in m["entries"]:
    if e["record"].endswith("X08/out/X08.handoff.json") and e["field"] == "resultSha": e["brokenSha"] = "9"
json.dump(m, open(man, "w"), indent=2, sort_keys=True)
PYAMB
git commit -qam "negative 5a: abbreviation shorter than 7 hex"; check "5a too-short abbreviation refused" "not a git abbreviation" 1
restore
NODUP=0000000; while [ "$(git rev-list --all | grep -c "^$NODUP")" != "0" ]; do NODUP=$(printf '%07d' $((10#$NODUP + 1))); done
echo "     (reachable commits named by prefix '$NODUP': $(git rev-list --all | grep -c "^$NODUP"); duplicate 7-hex commit prefixes in this repository: $(git rev-list --all | cut -c1-7 | sort | uniq -d | wc -l | tr -d ' '))"
python3 - "$REC" "$MAN" "$NODUP" <<'PYNONE'
import json, sys
rec, man, prefix = sys.argv[1], sys.argv[2], sys.argv[3]
r = json.load(open(rec)); r["resultSha"] = prefix; json.dump(r, open(rec, "w"), indent=2, sort_keys=True)
m = json.load(open(man))
for e in m["entries"]:
    if e["record"].endswith("X08/out/X08.handoff.json") and e["field"] == "resultSha":
        e["brokenSha"] = prefix
        e["replacement"] = prefix + "0123456789abcdef0123456789abcdef01234"[:33]
json.dump(m, open(man, "w"), indent=2, sort_keys=True)
PYNONE
git commit -qam "negative 5b: prefix that names no commit"; check "5b prefix naming no commit refused" "denotes 0 reachable commits" 1
restore

# 6. An entry parked on a pointer that is fine: entries are for breaks, and a stale one hides the next
#    real break on the same field by occupying its key.
python3 - "$MAN" <<'PYHEALTHY'
import json, sys
p = sys.argv[1]; m = json.load(open(p))
m["entries"].append({"record": "docs/specs/harness-reliability-bootstrap-20261103/X08/out/X08.handoff.json",
                     "field": "baseSha", "taskId": "X08", "brokenSha": "45d42acb70fc2fcac76425d18eb1d651b0e0a9ba",
                     "defect": "malformed", "kind": "abbreviated", "rule": "uniqueAbbreviation",
                     "replacement": "45d42acb70fc2fcac76425d18eb1d651b0e0a9ba", "annotatedBy": "733e4486540d03c349b7f8425d1dcb9c511c5bd1"})
m["count"] = len(m["entries"]); json.dump(m, open(p, "w"), indent=2, sort_keys=True)
PYHEALTHY
git commit -qam "negative 6: entry parked on a healthy pointer"; check "6 entry on a healthy pointer refused" "DEFECT_GONE" 1
restore

# 7. The vocabulary is closed: a kind the scanner does not know is a failure, not a pass.
edit_entry kind guaranteed
git commit -qam "negative 7: invented kind"; check "7 unknown kind refused" "unknown kind" 1
restore

# 8. Self-certification: the commit whose pointer is abbreviated declares it itself. That commit is
#    the moment the pointer was stamped wrong -- nobody had looked at the shape yet -- so the entry
#    would be the record vouching for itself.
edit_entry annotatedBy 9f0644507e51baea9f6d0a75fc838e046c4143b7
git commit -qam "negative 8: annotatedBy is the defective commit itself"; check "8 self-certifying entry refused" "cannot declare its own defect" 1
restore

# 9. A declaration dated before the defect it declares.
OLD=$(git rev-list HEAD | tail -1)
echo "     (oldest reachable commit $OLD, committer date $(git show -s --format=%cd --date=iso "$OLD"); defect commit 9f0644507e51 $(git show -s --format=%cd --date=iso 9f0644507e51baea9f6d0a75fc838e046c4143b7))"
edit_entry annotatedBy "$OLD"
git commit -qam "negative 9: annotatedBy predates the defect"; check "9 back-dated entry refused" "precedes the defect commit" 1
restore
echo
echo "### reset to $(git rev-parse --short HEAD); scratch worktree clean: $([ -z "$(git status --porcelain)" ] && echo yes || echo NO)"
run | tail -2
OUTDIR=$SCRATCH
WC=$(git -C "$C" worktree list | wc -l | tr -d ' ')
cleanup
rm -rf "$(dirname "$OUTDIR")" 2>/dev/null
echo "### ended $(date -u +%H:%M:%S); scratch $OUTDIR removed: $([ -d "$OUTDIR" ] && echo NO || echo yes); worktree count before cleanup: $WC"
