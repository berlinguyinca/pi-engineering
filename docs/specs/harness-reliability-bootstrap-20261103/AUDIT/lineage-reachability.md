# Handoff-lineage reachability

```sh
node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/lineage-scan.mjs [ref]   # default HEAD
```

**Why this exists.** Every handoff record declares three commit pointers — `baseSha`,
`resultSha`, `nextBaseSha`. Audits before this one proved them by existence
(`git cat-file -e <sha>^{commit}`), and existence is the wrong test: an object can be present in
the local object store while **no ref carries it**, and a fresh clone only contains what refs
carry. Such a pointer cannot be checked out, re-verified, or bisected by anyone who did not already
hold the object — it is decorative. `git fsck --unreachable` is full of such commits in this
repository, which is exactly the failure mode.

**What the scan found** at `4ffa82f3`, over all 95 tracked `*/out*/*.handoff.json` × 3 fields =
285 pointers:

| | count |
|---|---|
| reachable from at least one ref | 244 |
| `null` — schema-legal (`"string","null"`): nothing declared / chain ends | 12 |
| **broken** | **29** |

The 29 break down as `baseSha` 7, `resultSha` 7, `nextBaseSha` 15 — of which 21 are
`object_missing` (`H01`–`H07`, `R08`) and 8 are `unreachable_from_any_ref` (`V02`–`V05`,
`X01`–`X04`, all in `out-corrected/`). Arithmetic self-check: 244 + 12 + 29 = 285.

**Why nothing was re-stamped.** `handoffHash` is the SHA-256 over deterministic sorted-key UTF-8
serialisation of the record excluding `handoffHash` itself — `02-HANDOFF-PROTOCOL.md:15`,
implemented as `canonicalHash` at `src/bootstrap/resultGate.ts:30` (it was line 15 until X13 reformatted that
file to make `npm run lint` pass). It binds the pointers to the
record's log paths and proof hashes, so editing one silently decouples an accepted record from the
logs it vouches for. The breaks are declared in `lineage-superseded.json` instead, and the gate
re-verifies every entry live on every run.

**Two kinds of entry, deliberately not interchangeable:**

- `superseded` (8) — a reachable commit with a **byte-identical commit subject** exists, so it is
  provably the same commit after a rewrite; `replacement` may be used as the pointer. Cross-check
  that validates the rule: for `V04` it derives `fc471225` and for `V05` `d44672d4`, which are
  exactly the shas their own `out-final` records already name.
- `unresolvable` (21) — `replacement: null`. No live commit is provably the declared value: the
  per-unit commits were lost when the generation was batch-committed (`9cf164fa` *"docs(bootstrap):
  H01-H07 handoff evidence trees"*). `annotatedBy` names the reachable commit that carries the
  record and its evidence, which makes the **generation** reproducible even though the **pointer**
  is not — and it MUST NOT be substituted for the pointer.

**What the gate fails on**, each exercised against real commits rather than asserted:

| code | how it was provoked | result |
|---|---|---|
| `UNCOVERED` | committed a `resultSha` pointing at `4e011af4`, a real commit that exists with `for-each-ref --contains` count 0 | exit 1 |
| `STALE` | edited a declared `brokenSha` in the manifest | exit 1 |
| `BAD_REPL` | superseded replacement → a missing object, then → `4e011af4` (exists, unreachable): both branches | exit 1 |
| `BAD_ANNOTATION` | unresolvable entry given a `replacement`, and an `annotatedBy` that is a lost object | exit 1 (×2) |
| `DEFECT_GONE` | appended an entry for a pointer that resolves | exit 1 |
| — | `HEAD`, unmodified | `RESULT ok`, exit 0 |

**To clear an entry**, re-stamp the record *and* its hash together in a fresh generation directory,
with the recomputation logged — the `*/logs/NN-stamp.txt` pattern already used by 53 tracked logs
(e.g. `D01/logs/05-stamp.txt`, `D05/logs/08-stamp-accepted.txt`). Note that `V03`, `V04` and `V05`
have **no** tracked stamp log (`V04/logs/` is `01-typecheck` … `05-diff-check`), so their accepted
hashes are verifiable only by recomputation. Do not edit a record in place.

**Discipline note from building this.** An earlier version of this gate matched replacement commits
with `git log --grep` on a regex-escaped subject; escaping turned subject parentheses into groups and
silently matched nothing, which lost all 8 twins. It now uses `-F` (fixed string) plus an exact
subject comparison. Likewise, a control run against a hand-typed 40-hex id proved nothing when the
tail was wrong: **derive every sha from command output, never from memory.**
