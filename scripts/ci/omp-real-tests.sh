#!/usr/bin/env bash
# Run every OMP_BIN-gated test file against a real omp, plus the legacy-golden parity gate with PARITY_PATH=omp.
# Fails if any test fails OR SKIPS: a skip here means provisioning regressed (the tests skip when OMP_BIN is unset),
# which must never read as green. OMP_BIN/OMP_BIN_ARGS are honoured when already set (local runs); otherwise the
# pinned omp is provisioned by scripts/ci/provision-omp.sh.
set -euo pipefail
cd "$(dirname "$0")/../.."

if [ -z "${OMP_BIN:-}" ]; then
  prov=$(scripts/ci/provision-omp.sh) || { echo "provisioning failed: scripts/ci/provision-omp.sh exited $? (see its log above); refusing to run the real-omp tests" >&2; exit 1; }
  OMP_BIN=$(printf '%s\n' "$prov" | sed -n 's/^OMP_BIN=//p')
  OMP_BIN_ARGS=$(printf '%s\n' "$prov" | sed -n 's/^OMP_BIN_ARGS=//p')
  [ -n "$OMP_BIN" ] || { echo "provisioning failed: provision-omp.sh printed no OMP_BIN" >&2; exit 1; }
fi
[ -n "${OMP_BIN:-}" ] && [ -x "$OMP_BIN" ] || { echo "OMP_BIN is not an executable: '${OMP_BIN:-}'" >&2; exit 1; }
export OMP_BIN OMP_BIN_ARGS="${OMP_BIN_ARGS:-}"

# The provisioned omp must not reach the network at test time: the scripted model is on loopback.
export HTTP_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 ALL_PROXY=http://127.0.0.1:9
export http_proxy=$HTTP_PROXY https_proxy=$HTTPS_PROXY all_proxy=$ALL_PROXY NO_PROXY=127.0.0.1,localhost,::1 no_proxy=127.0.0.1,localhost,::1

# Linux: process cwd comes from /proc (no lsof needed); pgrep (procps) is required by two tests.
command -v pgrep >/dev/null || { echo "pgrep (procps) is required by the real-omp tests" >&2; exit 1; }

# Derived, not listed: a new gated file is picked up by the grep and cannot be forgotten. legacy-golden is
# gated through test/support and runs separately under PARITY_PATH=omp.
FILES=()
while IFS= read -r f; do FILES+=("$f"); done < <(grep -lE 'realOmpEnv\(|process\.env\.OMP_BIN' test/unit/*.test.ts test/integration/*.test.ts | sort)
# EXPECTED_GATED_FILES is the count recorded when the gate was written. A renamed or de-gated file drops the count
# and fails here; adding a gated file means raising this number in the same commit.
EXPECTED_GATED_FILES=10
[ "${#FILES[@]}" -ge "$EXPECTED_GATED_FILES" ] || { echo "expected at least $EXPECTED_GATED_FILES OMP_BIN-gated test files, found ${#FILES[@]}: ${FILES[*]}" >&2; exit 1; }
# shellcheck disable=SC2086
echo "real omp: $OMP_BIN $OMP_BIN_ARGS -> $("$OMP_BIN" $OMP_BIN_ARGS --version 2>&1 | head -1)"
echo "gated files (${#FILES[@]}): ${FILES[*]}"

CONC=$(( ${PE_TEST_CONCURRENCY:-4} / 2 ))
[ "$CONC" -ge 1 ] || CONC=1
run() { # label, then env assignments and files passed via the globals below
  local label=$1; shift
  local log; log=$(mktemp); trap 'rm -f "$log"' RETURN
  local rc=0
  timeout -k 30 25m node --test --test-concurrency="$CONC" --test-force-exit --test-timeout=600000 \
    --import ./test/support/isolatedState.ts "$@" >"$log" 2>&1 || rc=$?
  grep -E '^ *not ok' "$log" | head -50 || true
  grep -E '^# (tests|pass|fail|cancelled|skipped|todo|duration_ms)' "$log" || true
  local tests skipped
  tests=$(sed -n 's/^# tests \([0-9]*\).*/\1/p' "$log" | tail -1)
  skipped=$(sed -n 's/^# skipped \([0-9]*\).*/\1/p' "$log" | tail -1)
  [ "$rc" -eq 0 ] || { echo "$label: node --test exited $rc" >&2; return 1; }
  [ "${tests:-0}" -gt 0 ] || { echo "$label: no tests ran" >&2; return 1; }
  [ "${skipped:-x}" = "0" ] || { echo "$label: skipped=${skipped:-unparsed}, expected 0 (provisioning regression?)" >&2; return 1; }
  echo "$label: $tests tests, 0 skipped, 0 failed"
}

run "omp-gated" "${FILES[@]}"
PARITY_PATH=omp run "legacy-golden PARITY_PATH=omp" test/integration/legacy-golden.test.ts
