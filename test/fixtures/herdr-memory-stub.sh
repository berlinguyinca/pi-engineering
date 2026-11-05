#!/bin/sh
# Stand-in for the `herdr-memory` CLI used by the integration tests.
#
# Same argv the provider really passes (`retain <text> --scope … --provenance …`,
# `recall <query> --max-results N --scope …`) and the same JSON out
# (`{outcome, memory_id}` / `{results:[{memory_id, text, …}]}` — the real CLI's
# shape), backed by one file so a second test session can read what the first
# one wrote. It talks to no network and needs no credential.
#
# Shell rather than node on purpose: automatic recall races a 250 ms deadline,
# and a node child process would spend most of that budget starting up.
#
# Behaviour switches, set by the test through the environment (never a token):
#   MEMORY_STUB_DB    file holding one stored note per line (required)
#   MEMORY_STUB_FAIL  "1" makes every call exit non-zero, like a broken CLI
set -u

db=${MEMORY_STUB_DB:?MEMORY_STUB_DB must point at the storage file}
if [ "${MEMORY_STUB_FAIL:-}" = "1" ]; then
  exit 1
fi

action=${1:-}
shift || true

# A stub, not a serialiser: JSON-hostile characters are dropped rather than
# escaped, which is enough for the fixed sentences these tests store.
sanitize() { printf '%s' "$1" | tr -d '\\"'; }

row() {
  printf '{"memory_id":"m%s","text":"%s","status":"promoted","revision":%s,"provenance":{"evidence_refs":["stub:evidence"]}}' \
    "$1" "$(sanitize "$2")" "$1"
}

case "$action" in
  retain)
    printf '%s\n' "$1" >> "$db"
    n=$(grep -c . "$db")
    printf '{"outcome":"persisted","memory_id":"m%s","revision":%s}' "$n" "$n"
    ;;
  recall)
    if [ ! -f "$db" ]; then
      printf '{"results":[]}'
      exit 0
    fi
    query=${1:-}
    first=1
    i=0
    printf '{"results":['
    while IFS= read -r line; do
      if [ "$query" != "*" ]; then
        # The provider sends joined query terms, not a phrase: a row matches
        # when the text mentions any one of them, which is what the real CLI
        # scores on. Matching the whole string would find nothing.
        lowered=$(printf '%s' "$line" | tr 'A-Z' 'a-z')
        hit=0
        for term in $query; do
          needle=$(printf '%s' "$term" | tr 'A-Z' 'a-z')
          case "$lowered" in
            *"$needle"*) hit=1 ;;
          esac
        done
        [ "$hit" = 1 ] || continue
      fi
      i=$((i + 1))
      if [ "$first" = 1 ]; then first=0; else printf ','; fi
      row "$i" "$line"
    done < "$db"
    printf ']}'
    ;;
  forget)
    printf '{"outcome":"forgotten"}'
    ;;
  *)
    exit 2
    ;;
esac
