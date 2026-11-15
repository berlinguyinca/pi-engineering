#!/usr/bin/env bash
# Provision the pinned real omp for the OMP_BIN-gated tests, reproducibly, with no upstream script run.
#
# Same recipe the phase-2 spike used locally (docs/specs/omp-unification-2026-11-13/reports/phase2-adapter-spike.md):
#   * Bun 1.4.4        official npm tarball @oven/bun-linux-x64, sha256-verified, only bin/bun is used
#   * omp 18.20.0      git fetch --depth 1 of can1357/oh-my-pi at the pinned commit, then
#                      `bun install --frozen-lockfile --ignore-scripts` (no postinstall runs)
#   * native addon     published @oh-my-pi/pi-natives-linux-x64@18.20.0 (modern + baseline .node), sha256-verified;
#                      NOT built from the pinned source
# To change a pin, change the version and its digest together (see docs/operations/ci.md "Real-omp tests").
#
# stdout: exactly two lines, `OMP_BIN=<path>` and `OMP_BIN_ARGS=<path>`; everything else goes to stderr.
# Cache: $PE_OMP_CACHE (default /tmp/woodpecker-cache), keyed by the three pins, placed by atomic rename.
set -euo pipefail

BUN_VER=1.4.4
BUN_PKG=bun-linux-x64
BUN_SHA256=93ca5a2abe45f3bcac6dd55baff8bb06c4ac824b70f89650b54e5c8b80dbef18
# npm dist.integrity: sha512-CHbbkmHVM28T1GFq+6GL4Ao4ujwwYwj1CxFFwEFzLanPfNsId9AhbIP0Q4reWuWBkGimUkoQygrK7Rgjtj3vog==
OMP_VER=18.20.0
OMP_COMMIT=57263720c818ab3baaeb74bf415b03592b806ae0
NATIVES_SHA256=46a6be7c32082b4ae17f7bac3593a5b153453bf5c7eccec0beaa419e02cf7a7d
# npm dist.integrity: sha512-ro0Aju4IQ/jgYM7dw9ZQHCpnbF8LmV7UGP52pGWNYFhkdJ0C5R35mmC57X/M6iJfIBJeQRojvS3f3sWSTyF4wA==

log() { echo "provision-omp: $*" >&2; }

[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { log "only linux-x86_64 is pinned here (got $(uname -s)-$(uname -m)); set OMP_BIN yourself"; exit 1; }

CACHE=${PE_OMP_CACHE:-/tmp/woodpecker-cache}
ROOT="$CACHE/pe-omp-$OMP_VER-${OMP_COMMIT:0:8}-bun$BUN_VER"
NATIVE_DIR=packages/natives/native

emit() {
  echo "OMP_BIN=$ROOT/bun/bin/bun"
  echo "OMP_BIN_ARGS=$ROOT/omp/packages/coding-agent/src/cli.ts"
}

ready() {
  [ -f "$ROOT/.provisioned" ] \
    && [ "$("$ROOT/bun/bin/bun" --version 2>/dev/null)" = "$BUN_VER" ] \
    && [ -f "$ROOT/omp/$NATIVE_DIR/pi_natives.linux-x64-baseline.node" ] \
    && [ -f "$ROOT/omp/$NATIVE_DIR/pi_natives.linux-x64-modern.node" ]
}

if ready; then log "reusing $ROOT"; emit; exit 0; fi

mkdir -p "$CACHE"
TMP="$CACHE/.pe-omp-dl-$$-$RANDOM"
mkdir -p "$TMP"
trap 'rm -rf -- "$TMP"' EXIT

fetch() { # url sha256 dest
  timeout -k 30 10m curl -fsSL --retry 2 "$1" -o "$3"
  echo "$2  $3" | sha256sum -c - >&2
}

log "bun $BUN_VER"
fetch "https://registry.npmjs.org/@oven/$BUN_PKG/-/$BUN_PKG-$BUN_VER.tgz" "$BUN_SHA256" "$TMP/bun.tgz"
mkdir -p "$TMP/stage/bun/bin" "$TMP/bunx"
tar -xzf "$TMP/bun.tgz" -C "$TMP/bunx" package/bin/bun
mv "$TMP/bunx/package/bin/bun" "$TMP/stage/bun/bin/bun"
chmod 755 "$TMP/stage/bun/bin/bun"
[ "$("$TMP/stage/bun/bin/bun" --version)" = "$BUN_VER" ] || { log "bun --version is not $BUN_VER"; exit 1; }

log "oh-my-pi $OMP_COMMIT"
OMP="$TMP/stage/omp"
mkdir -p "$OMP"
git -C "$OMP" init -q
git -C "$OMP" remote add origin https://github.com/can1357/oh-my-pi.git
timeout -k 30 10m git -C "$OMP" fetch -q --depth 1 origin "$OMP_COMMIT"
git -C "$OMP" checkout -q --detach FETCH_HEAD
[ "$(git -C "$OMP" rev-parse HEAD)" = "$OMP_COMMIT" ] || { log "checked out $(git -C "$OMP" rev-parse HEAD), expected $OMP_COMMIT"; exit 1; }
# Own cache dir: the step's HOME is not shared, and nothing may land outside $TMP.
(cd "$OMP" && BUN_INSTALL_CACHE_DIR="$TMP/bun-cache" timeout -k 30 15m "$TMP/stage/bun/bin/bun" install --frozen-lockfile --ignore-scripts >&2)

log "native addon @oh-my-pi/pi-natives-linux-x64@$OMP_VER"
fetch "https://registry.npmjs.org/@oh-my-pi/pi-natives-linux-x64/-/pi-natives-linux-x64-$OMP_VER.tgz" "$NATIVES_SHA256" "$TMP/natives.tgz"
mkdir -p "$TMP/natx"
tar -xzf "$TMP/natives.tgz" -C "$TMP/natx" package/pi_natives.linux-x64-baseline.node package/pi_natives.linux-x64-modern.node
mv "$TMP/natx/package/"pi_natives.linux-x64-*.node "$OMP/$NATIVE_DIR/"

echo "bun $BUN_VER omp $OMP_VER $OMP_COMMIT natives sha256 $NATIVES_SHA256" > "$TMP/stage/.provisioned"

# Place atomically. If a concurrent pipeline won the race, theirs is verified by ready() below, not trusted.
if [ ! -e "$ROOT" ]; then mv "$TMP/stage" "$ROOT" 2>/dev/null || true; fi
ready || { log "$ROOT is not a working provision; it is owned by this pin alone, remove it: rm -rf $ROOT"; exit 1; }
"$ROOT/bun/bin/bun" "$ROOT/omp/packages/coding-agent/src/cli.ts" --version | grep -qx "omp/$OMP_VER" \
  || { log "omp --version is not omp/$OMP_VER"; exit 1; }
log "provisioned $ROOT"
emit
