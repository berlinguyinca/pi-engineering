#!/bin/sh
# Stand-in for the `herdr-memory` CLI used by the integration tests.
#
# Same argv the provider really passes (`retain <text> --scope … --provenance …`,
# `recall <query> --max-results N --scope …`) and the same JSON out
# (`{outcome, memory_id}` / `{results:[{memory_id, text, …}]}` — the real CLI's
# shape), backed by one file so a second test session can read what the first
# one wrote. It talks to no network and needs no credential.
#
# Shell keeps the CLI boundary fast and deterministic under the automatic-recall budget.
# documents/get use normalized addresses, just like the canonical client.
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
  printf '{"memory_id":"m%s","text":"%s","bank_id":"canary-facts","status":"verified","revision":%s,"provenance":{"evidence_refs":["stub:evidence"]}}' \
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
  documents)
    limit=100
    offset=0
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --limit) limit=$2; shift 2 ;;
        --offset) offset=$2; shift 2 ;;
        --scope|--kind) shift 2 ;;
        *) shift ;;
      esac
    done
    total=0
    [ ! -f "$db" ] || total=$(grep -c . "$db")
    printf '{"bank_id":"canary-facts","scope":"project","total":%s,"total_is_estimate":false,"documents":[' "$total"
    i=0
    emitted=0
    if [ -f "$db" ]; then
      while IFS= read -r line; do
        i=$((i + 1))
        [ "$i" -gt "$offset" ] || continue
        [ "$emitted" -lt "$limit" ] || break
        [ "$emitted" = 0 ] || printf ','
        printf '{"address":"m%s","status":"verified","revision":1}' "$i"
        emitted=$((emitted + 1))
      done < "$db"
    fi
    printf ']}'
    ;;
  get)
    id=${1#m}
    case "$id" in ''|*[!0-9]*) exit 2 ;; esac
    [ -f "$db" ] || exit 1
    text=$(sed -n "${id}p" "$db")
    [ -n "$text" ] || exit 1
    row "$id" "$text"
    ;;
  forget)
    printf '{"outcome":"forgotten"}'
    ;;
  *)
    exit 2
    ;;
esac
