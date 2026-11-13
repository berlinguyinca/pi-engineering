#!/bin/bash
# X10 diagnostic driver. $1=tree $2=label $3=concurrency (default 4) $4=wall seconds per copy (default 240).
# Runs N copies of test/integration/worker-budget-build-hint.test.ts at once in the given tree. See
# X10/logs/05-budget-hint-load-flake.txt for what it proved.
# Verdict: every copy finishing with exit 0 = healthy; a copy hitting the wall timeout = the hang this hunt is about.
cd "$1" || exit 70
n=${3:-4}; t=${4:-240}
echo "### $2  tree=$(git rev-parse --short HEAD)  started=$(date -u +%H:%M:%S)  concurrency=$n wall=${t}s load=$(sysctl -n vm.loadavg | tr -d '{}')"
rc=0
for i in $(seq "$n"); do
  ( timeout "$t" node --test --test-force-exit --import ./test/support/isolatedState.ts test/integration/worker-budget-build-hint.test.ts > "/tmp/bbh4-$2-$i.txt" 2>&1; echo "exit=$?" >> "/tmp/bbh4-$2-$i.txt" ) &
done
wait
for i in $(seq "$n"); do
  f="/tmp/bbh4-$2-$i.txt"
  line=$(grep -E '^ℹ (tests|pass|fail)' "$f" 2>/dev/null | sed 's/ℹ //' | tr '\n' ' ')
  code=$(grep -o 'exit=[0-9]*' "$f" 2>/dev/null)
  dur=$(grep -o 'duration_ms [0-9]*' "$f" 2>/dev/null | sed 's/duration_ms //;s/\..*//')
  [ "${code#exit=}" = "0" ] || rc=1
  echo "  copy$i: ${line:-NO SUMMARY (stuck past ${t}s or file-level failure)} ${code} dur=${dur:-?}ms"
done
echo "verdict: $([ $rc -eq 0 ] && echo PASS || echo 'FAIL/HANG')  ended=$(date -u +%H:%M:%S)"
