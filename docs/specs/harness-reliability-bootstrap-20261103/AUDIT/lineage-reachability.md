# Handoff-lineage reachability

```sh
node docs/specs/harness-reliability-bootstrap-20261103/AUDIT/lineage-scan.mjs [ref]   # default HEAD
```

**Why this exists.** Every handoff record carries `nextBaseSha`, the commit the next task is
supposed to start from. Audits before this one proved those pointers by existence
(`git cat-file -e <sha>^{commit}`), and existence is the wrong test: an object can be present
in the local object store while **no ref carries it**, and a fresh clone only contains what
refs carry. Such a record cannot be checked out, re-verified, or bisected by anyone who did not
already have the object — the pointer is decorative.

At `4ffa82f3` the scan of all 95 tracked `*/out*/*.handoff.json` gives
**68 reachable, 12 `null` (schema-legal: the chain ends there), 15 broken**:

- `unreachable_from_any_ref` — 8: `V02`–`V05` and `X01`–`X04`, all in `out-corrected/`. Each
  names the pre-rewrite twin of a commit that is on the chain, so the generation is fine and
  only the pointer is stale.
- `object_missing` — 7: `H01`–`H06` and `R08/out-corrected`. No such object in this repository.

**Why nothing was re-stamped.** `handoffHash` is the SHA-256 over deterministic sorted-key
UTF-8 serialisation of the record excluding `handoffHash` itself — `02-HANDOFF-PROTOCOL.md:15`,
implemented as `canonicalHash` at `src/bootstrap/resultGate.ts:15` and used by
`src/bootstrap/handoffWriter.ts`. It therefore binds `nextBaseSha` together with the recorded log
paths and proof hashes. Editing a pointer silently decouples an accepted record from the logs
it vouches for. So the broken pointers are declared in `lineage-superseded.json` — record path,
declared pointer, defect kind, and a live replacement plus the rule that produced it
(`sameSubjectRewrite`, or `recordAddedBy` when the object is gone and has no subject to match) —
and the gate re-verifies each entry live on every run.

**What the gate fails on.** `UNCOVERED` (a break with no manifest entry), `STALE` (manifest
pointer no longer matches the record), `DEFECT_GONE` (fix landed, entry must be pruned),
`BAD_REPL` (declared replacement is itself missing or unreachable), `DUPLICATE`. All four were
exercised against real commits, not asserted: an uncovered break was produced by committing a
pointer to `e6ad2208ad77` (exists, no ref), a stale entry by editing a declared pointer, a bad
replacement by pointing an entry at a missing object. Each returned exit 1; `HEAD` returns 0.

**To clear an entry**, re-stamp the record *and* its hash together, in a fresh generation
directory, with the recomputation logged — the `*/logs/NN-stamp.txt` pattern already used by 53
tracked logs (e.g. `D01/logs/05-stamp.txt`, `D05/logs/08-stamp-accepted.txt`,
`D06/logs/07-stamp-accepted.txt`). Note that `V03`, `V04` and `V05` have **no** tracked stamp log
(`V04/logs/` is `01-typecheck` … `05-diff-check`), so their accepted hashes are currently
verifiable only by recomputing them, as this scan's sibling checks do. Do not edit a record in
place.
