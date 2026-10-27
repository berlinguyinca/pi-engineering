#!/usr/bin/env bash
# Run the real PostgreSQL integration in an owned, socket-only temporary cluster.
# Prerequisites: PostgreSQL server tools, Node 22, npm ci --prefix services/openviking.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
pg_bindir="${PG_BINDIR:-$(pg_config --bindir)}"
for tool in initdb pg_ctl createdb; do
  test -x "$pg_bindir/$tool" || { echo "Missing PostgreSQL tool: $pg_bindir/$tool" >&2; exit 1; }
done
if test "$(id -u)" = 0; then
  echo "Run as an unprivileged user; initdb refuses root." >&2
  exit 1
fi
# Resolve from the service directory, where its existing pg dependency belongs.
(cd services/openviking && node --input-type=module -e 'await import("pg")') || {
  echo "Install the service dependencies with npm ci --prefix services/openviking." >&2
  exit 1
}

cluster_dir="$(mktemp -d /tmp/pi-openviking-pg.XXXXXX)"
cleanup() {
  "$pg_bindir/pg_ctl" -D "$cluster_dir/data" -m immediate -w stop >/dev/null 2>&1 || true
  rm -rf -- "$cluster_dir"
}
trap cleanup EXIT
mkdir "$cluster_dir/socket"
"$pg_bindir/initdb" -D "$cluster_dir/data" --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8 >"$cluster_dir/initdb.log"
# No TCP listener: the private directory isolates even concurrent runs on port 5432.
"$pg_bindir/pg_ctl" -D "$cluster_dir/data" -l "$cluster_dir/postgres.log" -o "-F -h '' -k $cluster_dir/socket -p 5432" -w start >/dev/null
"$pg_bindir/createdb" --host="$cluster_dir/socket" --port=5432 --username="$(id -un)" pi_openviking_test

# Replace, never inherit, TEST_DATABASE_URL. This can only name the owned cluster.
TEST_DATABASE_URL="postgresql://$(id -un)@localhost:5432/pi_openviking_test?host=$cluster_dir/socket"
export TEST_DATABASE_URL
node --test --import ./test/support/isolatedState.ts test/integration/openviking.test.ts
