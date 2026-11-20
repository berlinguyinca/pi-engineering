# CI runbook

Where the pipeline runs, how to reproduce a step locally, and the host assumptions that
have already cost a debugging cycle each.

## Where

Woodpecker CI at `ci.metabolomics.us`, repository `berlinguyinca/pi-engineering` (server
repo id 121). The pipeline definition is `.woodpecker/ci.yaml`.

The runners are **HPC@UCD hive Slurm exec hosts** — selected with `labels: cluster: hive`,
the same pool the org's other gates use. They are not containers: `image: bash` names an
executable on the agent, not an image, because the hosts have no docker, no apt and no
sudo. That is why every dependency the pipeline needs is either on the host or provisioned
by the pipeline into a shared path under `/tmp`.

Two consequences of that model that surprise people:

- **Each step gets a clean environment *and its own* `HOME`.** Anything one step downloads
  into `HOME` is invisible to the next, which is why the Playwright browser cache is pinned
  to `/tmp/woodpecker-cache/playwright` instead of `~/.cache`.
- **The clone plugin does not work on this backend** (it fails with no step logs), so the
  pipeline uses `skip_clone: true` plus a plain `git checkout` with the credential staged at
  `/etc/woodpecker-git-credentials`.

This replaced `.github/workflows/ci.yml`, removed in `85b1b06` when GitHub Actions billing
started failing. The full `npm run roadmap:check` is not a PR gate; it lives in
`.woodpecker/release-gate.yaml` and runs on `release/*` tags only.

The pipeline publishes a **commit status**, not a check run: `ci/woodpecker/push/ci` on a
branch push, `ci/woodpecker/pr/ci` on a pull request. When a merge is refused and GitHub
shows no failing check, look for that context — `gh api repos/OWNER/REPO/commits/SHA/status`.

## Merging requires CI to be green

An active branch ruleset, *CI must pass before merge (Woodpecker)*, requires the
`ci/woodpecker/pr/ci` status to succeed on the head commit of any PR targeting `main`. It
does **not** require the branch to be up to date (`strict_required_status_checks_policy` is
off), so a PR does not have to be rebased to merge.

Two things it deliberately does not do:

- **It does not bind repository admins.** `enforce_admins` is off on `main`, and an admin
  can still merge a red pipeline. That is the escape hatch for the case where CI itself is
  the thing that is broken; using it is visible in the merge history.
- **It is not the AI-review gate.** A separate ruleset, *Independent AI review*, governs
  review requirements. A PR can be blocked by either, and the reasons are reported
  separately.

### Watching the gate

Read the gate through the pull request rollup, which is where it shows up first:

```bash
gh pr checks <n> --watch --interval 60     # blocks until every check completes
gh pr view <n> --json statusCheckRollup \
  -q '.statusCheckRollup[] | "\(.context // .name) \(.state // .conclusion)"'
gh api repos/berlinguyinca/pi-engineering/commits/<head-sha>/status \
  -q '.statuses[] | "\(.context) \(.state) \(.target_url)"'
```

An empty read from any of these — including `no checks reported on the '<branch>' branch` —
means **not reported yet**, never *there is no CI*. Sampled once, it has never been evidence
of absence: on #729 the first sample printed exactly that line, and the same command minutes
later printed `ci/woodpecker/pr/ci pass` with a link to the run.

The endpoints disagree about *when* the status exists. Measured on #732 (head `daff7cb8`,
pipeline 333): `gh pr checks --watch` walked `pending` → `pass` and `statusCheckRollup`
reported SUCCESS, while `commits/<head>/status` still returned an empty `statuses` array at
t+45s and again at t+225s and carried the status only later. And a run can queue a long time:
the next head of that same PR (`53c829f6`, pipeline 335) sat `pending` for 43 minutes while
push pipelines on `main` finished in minutes — the hive pool is shared, so a pending pipeline
is a queue, not a verdict.

So wait: `gh pr checks <n> --watch`, or one long-interval check of the rollup. Do not
conclude from the first sample, do not re-poll at short intervals, and do not merge on local
verification alone because the gate has not reported yet.

The absence of `.github/` is not evidence about CI here either. GitHub Actions is disabled
on this repository (`actions/permissions` → `enabled: false`) because `85b1b06` removed the
workflows when Actions billing started failing; this pipeline replaced them. The pipeline
definitions in `.woodpecker/` are source like any other: `test/unit/woodpecker-variable-refs.test.ts`
fails when a pipeline pins a Node version and digest that differ from the others, or asks
Woodpecker to expand a variable it does not know, so a change to `ci.yaml` goes through a PR
and this suite, not through the server UI.

### How the runtime reads the same gate (#722)

The merge gate in `src/github/sync.ts` reads **both** GitHub surfaces for the head commit:
`/commits/<sha>/check-runs` (`GithubClient.listCheckRuns`) and `/commits/<sha>/statuses`
(`GithubClient.listCommitStatuses`), merged by `normalizeCheckRuns()` in
`src/merge/checkRunIngest.ts`. That second call is the whole of #722: Woodpecker publishes a
commit **status** named `ci/woodpecker/pr/ci` and never a check run, so before it existed the
gate saw only GitGuardian — a head with one green scanner and a pipeline that had never started
looked like CI evidence, and `mergeable: MERGEABLE` read as green.

The rules the ingestion applies:

- An unknown status state is a **failure**, never a pass (`commitStatusState`).
- The newest entry per context wins, keyed on `updated_at` then `created_at`, so a superseded
  run reporting `error` cannot mask the rerun that passed.
- A status or check run reported for a **different commit** reaches the gate, which rejects the
  merge (`check <name> sha … != head`) instead of dropping the row.
- A statuses call that cannot be answered counts as unreadable checks: the decision is `wait`
  with `no CI evidence: the checks could not be read`, never "no checks needed".

Name the pipeline in `github.required_checks` (`engineering.yaml`, see
`src/github/settings.ts`):

```yaml
github:
  enabled: true
  required_checks: [ci/woodpecker/pr/ci]
```

Without it the required set defaults to *the checks that reported*, which cannot notice an
absence — a pipeline that never started contributes no name to the set, so nothing waits for
it. With it, absence is a wait (`required check ci/woodpecker/pr/ci missing`) and a pending
pipeline is a wait, which is the fail-closed reading of the empty output described above.

## The pipeline provisions its own Node

```
checkout → node → toolchain → install → lint → typecheck → test-unit
         → test-integration → smoke → roadmap-structural → cleanup-venv
```

The `node` step downloads a **pinned, checksum-verified** Node tarball into the shared
cache and every step that runs `node`, `npm` or `npx` includes the `&node_env` anchor that
puts it first on `PATH`. The version and its sha256 are both in `ci.yaml`; `toolchain`
then asserts that `command -v node` *is* the provisioned binary, so a PATH mistake fails
loudly instead of quietly running the host's Node.

This exists because the exec hosts are shared infrastructure that this project does not
own and cannot upgrade — no sudo, no apt — and they ship a Node older than `package.json`
requires. Do not "fix" a Node version error by relaxing the engine range: provision a
newer one in the pipeline, which is what the `node` step is for.

To bump Node: change `NODE_VER`, put the new `node-v<VER>-linux-x64.tar.gz` sha256 in
`NODE_SHA256` (from the published `SHASUMS256.txt`, not from the download you are about to
verify), and open a PR. A stale digest fails the `node` step in seconds with a clear
message; a stale *directory* is detected by asking the binary to report its version, so an
old pin can never satisfy a new one.

## Reproducing a step locally

The steps are ordinary commands; the pipeline adds only the provisioned Node and a venv:

```sh
npm run lint          # biome over the tree
npm run typecheck     # tsc --noEmit
npm run test:unit     # node --test, per-test timeout, isolated state
PE_TEST_CONCURRENCY=2 npm run test:unit   # fewer workers on a busy machine (default 4)
```

## Coverage gate

`npm run test:coverage` runs the **unit** suite under Node's built-in coverage
(`src/**`, `extensions/**`; tests and scripts excluded) and fails below the thresholds in
`package.json`. The Woodpecker step `test-coverage` runs it after `test-integration`.

Unit-only is deliberate. A combined unit+integration run measured 96% lines idle on a laptop
but 56-58% under load and on CI (branches and functions stable), so the number depended on
machine load and could not gate anything. The unit suite gave identical results idle and
under load. Consequence: code reached only by integration tests is not counted.

Policy target is 80% for lines, branches and functions (Node reports no statements metric);
it is met on all three. Measured on Linux CI (pipeline 218, unit only) and enforced:

| metric | measured (Linux CI) | enforced | target |
|---|---|---|---|
| lines | 85.51 | 85 | 80 |
| branches | 83.23 | 83 | 80 |
| functions | 83.29 | 83 | 80 |

The enforced values sit just below the measurement so the gate ratchets and cannot regress.
Raise the flags as coverage improves. macOS gives the same numbers within 0.1.

`test:unit` passes `--test-timeout=600000`. That is a hang detector, not a performance
setting: a suite that blocks forever holds a runner and reports nothing, which is harder to
diagnose than a slow test.

## Real-omp tests

Step `test-omp-real` runs every `OMP_BIN`-gated test file (derived by grep, so a new gated file
is picked up) plus `test/integration/legacy-golden.test.ts` with `PARITY_PATH=omp`, against a
real, pinned omp. Without `OMP_BIN` those tests skip, which is how `test-integration` runs
them, so this step is the only place they execute in CI. Locally:
`OMP_BIN=<bun> OMP_BIN_ARGS=<omp>/packages/coding-agent/src/cli.ts scripts/ci/omp-real-tests.sh`
(unset `OMP_BIN` and it provisions the pinned linux-x64 omp itself).

The step **fails on any skipped test** (`# skipped` must be 0, `# tests` above 0), so a
provisioning regression cannot pass as green.

Provenance, the same recipe the phase-2 spike used locally (`scripts/ci/provision-omp.sh`;
no upstream install or postinstall script runs):

| Piece | Source | Pin |
| --- | --- | --- |
| Bun | npm tarball `@oven/bun-linux-x64@1.4.4`, only `bin/bun` used | sha256 `93ca5a2a...80dbef18` (npm integrity `sha512-CHbbkmHV...Ao4ujwwYwj1CxFFwEFzLanPfNsId9AhbIP0Q4reWuWBkGimUkoQygrK7Rgjtj3vog==`) |
| omp 18.20.0 | `git fetch --depth 1` of `can1357/oh-my-pi` at `57263720c818ab3baaeb74bf415b03592b806ae0`, `bun install --frozen-lockfile --ignore-scripts` | commit SHA, verified after checkout; deps pinned by `bun.lock` |
| Native addon | published npm `@oh-my-pi/pi-natives-linux-x64@18.20.0` (`modern` and `baseline` `.node`), copied into `packages/natives/native/` | sha256 `46a6be7c...f02cf7a7d` (npm integrity `sha512-ro0Aju4IQ/jgYM7dw9ZQHCpnbF8LmV7UGP52pGWNYFhkdJ0C5R35mmC57X/M6iJfIBJeQRojvS3f3sWSTyF4wA==`) |

The full digests are in the script. The addon is the published 18.20.0 artifact, **not built
from the pinned source** (same caveat as the spike). The provision is cached at
`/tmp/woodpecker-cache/pe-omp-18.20.0-57263720-bun1.4.4` and placed by atomic rename; to
raise a pin change the version and its digest together. The cache is not trusted on reuse: it lives in a 0700 directory (`pe-omp-cache`) the script
refuses to use if another user owns it or it is group/world-writable, and every reuse
re-hashes the whole tree (bun, the oh-my-pi source and `node_modules`, both `.node` files,
symlink targets; `.git` excluded) against a manifest taken at stage time. Any mismatch
deletes the entry and provisions again. Stale `.pe-omp-dl-*` download directories older than
an hour are swept at start.

Dependency finding: the pinned `bun.lock` has no git or github dependencies (the only
`git+https` strings are the packages' own `repository` URLs); everything installs from the
npm registry at lockfile versions, with `--frozen-lockfile --ignore-scripts`.

Provisioning needs the network
(registry.npmjs.org, github.com); the tests do not: the runner points `HTTP(S)_PROXY` at a
dead port with loopback exempt.

Linux notes: process working directories come from `/proc` (the tests use `lsof` only when
`/proc` is absent); `pgrep` (procps) must be on the agent, and the runner checks for it.
`/private/var` handling is `realpath`-based and a no-op on Linux. Not run on Linux before
this step existed: see the PR for what was and was not verified.

## Capacity

Pipelines on the shared hive host contend with each other. Observed: with several pipelines
running at once `test-unit` took 1740 s instead of about 220 s, and the timing-sensitive lock
and race tests then failed; a webhook storm produced 502s.

Changed in this repository:

- **Test concurrency follows the CPUs.** The `test:*` scripts read `PE_TEST_CONCURRENCY`
  (default 4, so laptops are unchanged). The test steps set it to half of `nproc` (which
  honours the Slurm cgroup), at least 2, at most 4 (`test-omp-real` uses half of that, minimum 1: every worker spawns a Bun process). This lowers oversubscription on small
  allocations; it cannot help when the host itself is oversubscribed by other pipelines.
- **The unit suite runs once.** The separate `test-unit` step is gone: `test-coverage` runs
  the same files with the same flags plus the coverage gate, and fails on any failing test.
- **No double run per PR.** Already the case: `when` limits `push` to `main`, so a PR branch
  builds on its `pull_request` event only.
- No retries were added. A retry would hide the failures this is about.

Server-side recommendations, **not applied** (not repository settings):

- The repo already has `cancel_previous_pipeline_events: [push, pull_request]`; confirm it
  actually fires (a superseded pipeline should end as `killed`), since it is the cheapest
  contention reducer.
- Limit concurrent pipelines on the hive pool: fewer agents or lower `WOODPECKER_MAX_WORKFLOWS`
  per agent, or a Slurm allocation sized for this repo (the suite wants about 4 free CPUs).
- Size the host for the suite: about 220 s idle versus 1740 s contended is the budget to size to.
- Webhooks: put a rate limit or queue in front of the Woodpecker webhook endpoint and check the
  forge's redelivery settings, so a burst of pushes yields queued pipelines, not 502s.

## Host assumptions that have already broken the build

Every one of these was green on macOS laptops and red on the first Linux run. The pattern
is the same in all of them: **the value looked right, and nothing asked the machine.**

**`XDG_RUNTIME_DIR` is a hint, not a promise.** A scheduler or container host can inherit
`/run/user/<uid>` from `pam_systemd` while `systemd-logind` never created the directory,
because a session that never becomes a real login session gets no user slice. Validating
the value's shape and then trusting it fails at the first `mkdir` of a child — `ENOENT`,
on a path the caller never chose. Use `usableRuntimeDir()` from
`src/platform/runtimeDir.ts`, which checks the directory is there and writable, and give
callers their own fallback (`/tmp` is short on every supported platform). The length cap is
a caller's constraint — a Unix socket path must fit `sun_path`, a registry path need not fit
anything — so it is a parameter, not a property of runtime directories.

**`HOME` is not always outside the temp dir.** A Woodpecker agent keeps its cache under
`/tmp` and `HOME` follows it. Anything that classifies "under the temp dir" as scratch
therefore treats everything under that home as scratch, which turned a workspace-scope
refusal into a silent authorization. If a heuristic means "throwaway", it has to say why
the path is throwaway and not merely where it is.

**A shared toolchain exports the operator's settings.** The hosts carry a shared cargo
install that puts `/usr/local/cargo/bin` on `PATH` and `CARGO_TARGET_DIR` in the
environment. The product honours `CARGO_TARGET_DIR` by turning its own Rust build cache
off, so a test that assumed the cache was on got `null` where it wanted a path.
`test/support/isolatedState.ts` is where ambient variables that are never a test input get
dropped; that is the place to fix the next one of these, not the individual test.

**`git` does not create `.git/hooks`.** A fixture that planted a hook by writing into
`.git/hooks` worked until git stopped making the directory. `mkdir -p` it.

**`sun_path` is 104 bytes including the terminator**, and Node's behaviour on an over-long
path has changed across versions. Budget it explicitly (`SOCKET_PATH_LIMIT`) and hang test
sockets off a short root — `os.tmpdir()` is the wrong root on macOS, where it is already a
58-byte per-user directory.

## Writing a test that survives the runner

- Do not copy a platform heuristic out of `src/` into a test. Import it. A copied rule in
  `test/unit/live-handoff-rpc.test.ts` is what made a whole file die at import time with no
  subtest output, which read as an unrelated Node-version bug for a while.
- If a test only passes because of an environment variable that happens to be unset, say
  so in the test — or set it. `XDG_RUNTIME_DIR` unset on macOS is why the socket fallback
  looked correct for months.
- If a test's fixture depends on a host shape (HOME under the temp dir, a path long enough
  to overflow a limit), assert the fixture got there. A test that silently cannot reach its
  condition is worse than one that fails.
- Do not make a claim about concurrency by counting entries inside a callback and comparing
  wall clocks. On a loaded agent the second dispatch arrives after the first body returns, and
  a correct implementation goes red. Ask the module that made the scheduling decision —
  `Scheduler.maxInFlight` records its own admission high-water precisely because admission is
  a synchronous decision, so the number does not depend on the host. This is the shared cause
  of #681, #682 and #689; each one was a green-on-idle-laptop assertion that measured the
  machine rather than the code.
