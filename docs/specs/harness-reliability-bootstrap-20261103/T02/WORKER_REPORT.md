# T02 worker report — Fail closed on dropped deny patterns

- Worktree: `/Users/wohlgemuth/IdeaProjects/worktrees/pi-t02-deny-origin-20261104`, branch `feat/t02-deny-origin`
- Base: `145549b5061f6b56b8c99645837e8361cd5b9be4` (T01 handoff `sha256:a8018b3dc9120df8ce1eaab8ad4efe806cd57e1c37b0aeea6dc06ca1719657c0`, status PASS)
- Commit: `d38a3d79` — `feat(planner): reject contradicted authorization denies instead of discarding (T02)` (exactly the two scoped files)

## Diff vs base (`git diff --numstat 145549b5061f6b56b8c99645837e8361cd5b9be4 HEAD`)

```
38	4	src/plannerWorker/contract.ts
42	0	test/unit/planner-worker-contract.test.ts
```

Total changed lines (added + deleted) = **84** (≤ 100). Production files changed: 1 (≤ 2). Test files changed: 1 (≤ 2). No other file touched (`git status --porcelain` clean apart from this untracked report).

## Commands and exit codes (run at the commit produced)

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` (`typecheck:core` + `typecheck:scripts`) | 0 | clean |
| `node --test --import ./test/support/isolatedState.ts test/unit/planner-worker-contract.test.ts` | 0 | 16 tests, 16 pass, 0 fail (14 pre-existing + 2 new) |
| `node --test --import ./test/support/isolatedState.ts test/unit/planner-worker-routing-constraints.test.ts` | 0 | 28 pass, 0 fail |
| `node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-path-policy.test.ts` | 0 | 3 pass, 0 fail |

`ls test/unit | grep -i path` returns exactly one path-policy file — `test/unit/bootstrap-path-policy.test.ts` — so that is the only one run. The full unit suite was **not** run (baselined red per handoff).

## Origin channel chosen

**Both shapes are accepted and merged.** Authorization-origin denies are read from
`raw.scope.forbidden_authorization` **and** `raw.authorization.denied`; each is passed through the
existing `stringList()` (so list/string coercion, length caps and non-string rejection are
identical to every other list field), the two channels are concatenated and de-duplicated into one
`authListed` list, and each entry is validated with the existing `scopeGlobError(glob, { deny: true })`
— malformed authorization globs (`/etc/**`, `../out/**`, `src/[ab].ts`, whitespace, non-string
entries) are refused as errors, never silently dropped.

Semantics implemented in `parseTaskContract`:

1. **Never discarded.** `authListed` never goes through `keepsDeny`, so it can never land in
   `ignored_forbidden`.
2. **Grant wholly inside a deny ⇒ reject.** For every (deny, grant) pair, `grantInsideDeny()` is true
   when the grant is a literal path the deny matches (`matchesGlob(grant, deny)`) or the grant's
   `staticPrefix` lies at/below the deny's `staticPrefix`. Each such pair pushes a stable error naming
   both — `<id>: scope.allowed "<grant>" is inside authorization deny "<deny>": nothing writable` —
   so the contract is rejected rather than the deny dropped.
3. **Narrowing deny ⇒ kept and tagged.** Authorization denies are unioned into `scope.forbidden`
   (de-duplicated with the kept planner denies, so `matchesScope()`/later enforcement enforces them
   unchanged) and additionally surfaced, origin-tagged, as `scope.forbiddenAuthorization` (present
   only when non-empty).
4. **Planner notes cannot remove one.** Omitting it leaves it enforced; restating it in
   `scope.forbidden` merges de-duplicated; granting inside it is case (2).

Type surface: `TaskContract`/`ContractScope` in `src/plannerWorker/types.ts` are **unchanged** (handoff
item 5 — the new field is not needed on the stored type). The tag is exposed through the parse result
instead: `export type ParsedContractScope = ContractScope & { forbiddenAuthorization?: string[] }` and
`ContractParse = { ok: true; contract: TaskContract & { scope: ParsedContractScope } } | …`, which keeps
the change inside the two scoped files and is structurally assignable everywhere `TaskContract` is
consumed (typecheck green). The parser stays pure and deterministic: no fs, no network, no clock, no
`Date`/`random`; only the existing glob helpers.

## Why unchanged planner-origin (`scope.forbidden`) keep/discard is safe

A planner-origin deny is model text inside one contract: it is an assertion by the entity whose own
write scope is being described, not a policy issued by the operator. Its blast radius is that single
contract, and every resolution of the contradiction stays inside the authority the planner already had
— keeping the deny narrows the contract's own scope, discarding it falls back to the explicit
`scope.allowed` list the same planner wrote, and `ignored_forbidden` reports the drop so the discard is
auditable rather than silent. Crucially, discarding a planner note can never *widen* what the host
permits: the allowed list is still validated independently by `scopeGlobError` (repository-relative,
no `..`, no `.git`, literal first segment), and any real restriction the operator intends now arrives
on the authorization channel, which is parsed separately and is never subject to `keepsDeny`. So the
asymmetry is authority-based, not convenience: for a planner note the contradiction is a self-inflicted
empty scope (the mission planner falls back on it), while for an authorization deny the same discard
would silently downgrade the operator's policy to whatever the model happened to grant — which is
exactly the hole T02 closes. Changing planner-origin behaviour was therefore left out of scope: it
would alter behaviour the handoff marks "explicitly reviewed" without closing any authorization hole,
and it is covered by a regression test asserting `ignored_forbidden` is unchanged from base.

## Tests added (2 blocks, all 14 pre-existing cases still pass)

- `authorization-origin denies are never discarded; a contradicting grant rejects the contract (T02)` —
  plan's named regression: broad grant `src/**` + authorization deny `src/secret/**` keeps the deny
  enforced (`scope.forbidden` + `scope.forbiddenAuthorization`, `ignored_forbidden` absent,
  `matchesScope` false for `src/secret/x.ts` and nested), and each of `src/secret/**`,
  `src/secret/x.ts`, `src/secret/deep/**`, `src/secret` granted alongside the deny is rejected with a
  reason naming grant + deny + "nothing writable"; also `authorization.denied` shape and a
  `staticPrefix` containment case (`src/se?et/**` vs `src/secret/x.ts`).
- `planner-origin keep/discard is unchanged and a planner note cannot outrank authorization denies (T02)` —
  planner wildcard `**/*.js` beside allowed `src/calc.js` still discards to `ignored_forbidden` with
  `src/legacy/**` kept and no `forbiddenAuthorization` key (base behaviour asserted); a planner note
  omitting an authorization deny leaves it enforced; restating it merges de-duplicated; malformed
  authorization globs/entries are refused on both channels.

## Deviations / notes

- **Environment fix (not a source change):** this worktree had no `node_modules`, so every test run
  failed with `ERR_MODULE_NOT_FOUND: yaml`. Per the repository AGENTS.md ("Symlink `node_modules` into
  the new worktree rather than reinstalling") `node_modules` is a symlink to the primary checkout's
  `node_modules`. It is gitignored and not committed; no package was installed.
- **Predecessor:** the previous T02 worker died because the anthropic credential is gone on this host;
  this run performed the work end to end and needed no model credential.
- No BLOCKED clause. Nothing outside the two scoped files was modified; nothing was pushed.

---

## Amendment 1 — conductor finding: coerced authorization values failed open

**Finding (accepted):** the two authorization channels reused the lenient `stringList`, which coerces
non-strings, so `authorization.denied: [42]` was ACCEPTED as deny `"42"`, `[true]` as deny `"true"`,
and `["src/secret/**", 7]` as `["src/secret/**", "7"]` — a malformed host constraint silently became an
invented deny pattern (fail-open class).

**Fix (production, `src/plannerWorker/contract.ts` only):** the authorization channels no longer use
`stringList`. Each channel is now read as: absent (`undefined`/`null`) ⇒ nothing added; not an array ⇒
error `<id>: <field> must be an array of strings`; array with any member that is not a string or is
empty after trim ⇒ error `<id>: <field>[<index>] must be a non-empty string` and **nothing** is added to
`authListed` for that channel; otherwise the strings are merged/de-duplicated as before. Planner-origin
`scope.forbidden` still uses `stringList` unchanged (verified below).

Machine-verified behaviour (`node --import ./test/support/isolatedState.ts` probe of `parseTaskContract`
with `scope.allowed: ["src/**"]`):

```
[42] -> REJECTED ["t1: t1.authorization.denied[0] must be a non-empty string"]
[true] -> REJECTED ["t1: t1.authorization.denied[0] must be a non-empty string"]
["src/secret/**",7] -> REJECTED ["t1: t1.authorization.denied[1] must be a non-empty string"]
"src/secret/**" -> REJECTED ["t1: t1.authorization.denied must be an array of strings"]
["src/secret/**"] -> ACCEPTED {"allowed":["src/**"],"forbidden":["src/secret/**"],"forbiddenAuthorization":["src/secret/**"]}
scope channel [42] -> REJECTED ["t1: t1.scope.forbidden_authorization[0] must be a non-empty string"]
planner forbidden [42] -> ACCEPTED (lenient stringList kept) ["42"]
```

**Test added (1 block):** `authorization channels refuse coerced values instead of inventing denies (T02)`
— refuses `[42]`, `[true]`, `["src/secret/**", 7]`, bare `"src/secret/**"`, `["  "]`, `[null]`, `[{}]`,
`{a:1}` on **both** channels, asserts the index-bearing message for `["src/secret/**", 7]`, and asserts a
well-formed array is still accepted.

**Line budget:** the previous 84 grew to exactly **100** changed lines (≤ 100). To stay inside it the
three T02 test blocks were rewritten more densely (helpers `auth`/`errOf`, looped assertions) with no
loss of asserted coverage: broad-grant + restricted-subtree deny stays enforced and `matchesScope` is
false for `src/secret/x.ts`, `src/secret/deep/x.ts`, `src/key.pem`; grants `src/secret/**`,
`src/secret/x.ts`, `src/secret/deep/**`, `src/secret` each reject naming grant + deny + "nothing
writable"; planner-origin `ignored_forbidden`/`forbidden` unchanged from base; restated note merges
de-duplicated with the authorization deny still tagged; malformed authorization globs (`/etc/**`,
`../out/**`, `src/[ab].ts`, `src/ hidden/**`) still refused. Dropped as redundant: the `src/se?et/**`
staticPrefix-only case and one duplicate `matchesScope`/`forbiddenAuthorization` assertion.

**Formatting:** `npx biome format src/plannerWorker/contract.ts test/unit/planner-worker-contract.test.ts`
is clean (exit 0, "No fixes applied"); the only >120-column line in the test file (line 157) is
pre-existing base content that biome itself leaves alone.

### Amend verification (commit `95aba353`, message unchanged, was `d38a3d79`)

`git diff --numstat 145549b5061f6b56b8c99645837e8361cd5b9be4 HEAD`

```
44	4	src/plannerWorker/contract.ts
52	0	test/unit/planner-worker-contract.test.ts
```

Total changed lines = **100** (≤ 100), 2 files only.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run typecheck` | 0 | clean |
| `node --test --import ./test/support/isolatedState.ts test/unit/planner-worker-contract.test.ts` | 0 | tests 17 / pass 17 / fail 0 (14 pre-existing + 3 T02) |
| `node --test --import ./test/support/isolatedState.ts test/unit/planner-worker-routing-constraints.test.ts` | 0 | 28 pass / 0 fail |
| `node --test --import ./test/support/isolatedState.ts test/unit/bootstrap-path-policy.test.ts` | 0 | 3 pass / 0 fail |
