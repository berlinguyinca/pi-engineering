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
# Cache: $PE_OMP_CACHE (default /tmp/woodpecker-cache)/pe-omp-cache, mode 0700, refused if owned by another user or
# group/world-writable. Entries are keyed by the three pins, placed by atomic rename, and RE-VERIFIED on every reuse
# against a sha256 manifest (path+hash of every file and symlink target) taken at stage time; a mismatch deletes
# the entry and provisions again.
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

if command -v sha256sum >/dev/null; then SHA256_CMD=(sha256sum); else SHA256_CMD=(shasum -a 256); fi
sha256_of() { "${SHA256_CMD[@]}" "$@"; }
stat_field() { stat -c "$1" "$3" 2>/dev/null || stat -f "$2" "$3"; } # GNU format, BSD format, path

# Sorted manifest of a provision tree: sha256 of every regular file, target of every symlink. The .git directory is
# excluded (objects are not executed); everything else, including all of node_modules, is covered.
manifest() { # dir
  (
    cd "$1"
    export LC_ALL=C
    find bun omp -name .git -prune -o -type f -print0 | sort -z | xargs -0 -n 512 "${SHA256_CMD[@]}"
    # shellcheck disable=SC2016 # the sh -c body expands $1 itself
    find bun omp -name .git -prune -o -type l -print0 | sort -z | xargs -0 -I{} sh -c 'printf "L  %s -> %s\n" "$1" "$(readlink "$1")"' _ {}
  )
}

# True when ROOT-like dir $1 carries a manifest and every file still hashes to it.
manifest_ok() { # dir
  [ -f "$1/.manifest" ] && manifest "$1" 2>/dev/null | cmp -s - "$1/.manifest"
}

# The provisioner's cache directory: ours, 0700, not writable by group/world.
secure_cache_dir() { # dir
  local d=$1 uid mode
  mkdir -p "$(dirname "$d")"
  [ -d "$d" ] || mkdir -m 700 "$d"
  [ ! -L "$d" ] || { log "refusing: $d is a symlink"; return 1; }
  uid=$(stat_field %u %u "$d")
  [ "$uid" = "$(id -u)" ] || { log "refusing: $d is owned by uid $uid, not $(id -u)"; return 1; }
  mode=$(stat_field %a %Lp "$d")
  case "$mode" in *[2367][0-7]|*[0-7][2367]) log "refusing: $d is group/world-writable (mode $mode)"; return 1;; esac
}

main() {
[ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || { log "only linux-x86_64 is pinned here (got $(uname -s)-$(uname -m)); set OMP_BIN yourself"; exit 1; }

CACHE=${PE_OMP_CACHE:-/tmp/woodpecker-cache}/pe-omp-cache
secure_cache_dir "$CACHE"
ROOT="$CACHE/$OMP_VER-${OMP_COMMIT:0:8}-bun$BUN_VER"
NATIVE_DIR=packages/natives/native

# Stale download dirs from killed pipelines (they hold no state worth keeping after an hour).
find "$CACHE" -maxdepth 1 -name '.pe-omp-dl-*' -mmin +60 -exec rm -rf -- {} + 2>/dev/null || true

emit() {
  echo "OMP_BIN=$ROOT/bun/bin/bun"
  echo "OMP_BIN_ARGS=$ROOT/omp/packages/coding-agent/src/cli.ts"
}

ready() {
  [ -f "$ROOT/.provisioned" ] \
    && [ -f "$ROOT/omp/$NATIVE_DIR/pi_natives.linux-x64-baseline.node" ] \
    && [ -f "$ROOT/omp/$NATIVE_DIR/pi_natives.linux-x64-modern.node" ] \
    && manifest_ok "$ROOT" \
    && [ "$("$ROOT/bun/bin/bun" --version 2>/dev/null)" = "$BUN_VER" ]
}

if [ -e "$ROOT" ]; then
  if ready; then log "reusing $ROOT (manifest verified)"; emit; return 0; fi
  log "cached $ROOT failed verification; deleting and provisioning again"
  rm -rf -- "$ROOT"
fi

TMP="$CACHE/.pe-omp-dl-$$-$RANDOM"
mkdir -m 700 "$TMP"
trap 'rm -rf -- "$TMP"' EXIT

fetch() { # url sha256 dest
  timeout -k 30 10m curl -fsSL --retry 2 "$1" -o "$3"
  echo "$2  $3" | sha256_of -c - >&2
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

manifest "$TMP/stage" > "$TMP/stage/.manifest"

# Place atomically; -T so an existing $ROOT is never entered (stage cannot land inside it). If a concurrent pipeline
# won the race, its tree is verified by ready() below, not trusted.
mv -T "$TMP/stage" "$ROOT" 2>/dev/null || true
ready || { log "$ROOT is not a working provision; it is owned by this pin alone, remove it: rm -rf $ROOT"; exit 1; }
"$ROOT/bun/bin/bun" "$ROOT/omp/packages/coding-agent/src/cli.ts" --version | grep -qx "omp/$OMP_VER" \
  || { log "omp --version is not omp/$OMP_VER"; exit 1; }
log "provisioned $ROOT"
emit
}

if [ "${BASH_SOURCE[0]:-}" = "$0" ]; then main; fi
