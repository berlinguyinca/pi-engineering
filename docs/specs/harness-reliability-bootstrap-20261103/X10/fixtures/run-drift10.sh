#!/bin/bash
# X10 cmd1: the ten files that were red alone at 147b8271 and green alone at origin/main, re-measured alone at this
# tree. One node process per file (concurrency 1) so a failure cannot be blamed on a neighbour. Exit status is the
# aggregate: 0 only when every file passes -- an earlier failure does not disappear behind a later success.
cd "$(git rev-parse --show-toplevel)" || exit 70
here="$(dirname "$0")"
rc=0
while read -r f; do
  [ -z "$f" ] && continue
  printf "%-56s " "$f"
  out=$(node --test --test-concurrency=1 --test-force-exit --import ./test/support/isolatedState.ts "$f" 2>&1)
  echo "$out" | grep -E "^ℹ (tests|pass|fail)" | tr '\n' ' ' | sed 's/ℹ //g'
  echo "dur=$(echo "$out" | grep -E '^ℹ duration_ms' | sed 's/ℹ duration_ms //;s/\..*//')ms"
  echo "$out" | grep -qE "^ℹ fail [1-9]" && rc=1
done < "$here/drift10.txt"
exit $rc
