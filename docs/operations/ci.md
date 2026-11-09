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
```

`test:unit` passes `--test-timeout=600000`. That is a hang detector, not a performance
setting: a suite that blocks forever holds a runner and reports nothing, which is harder to
diagnose than a slow test.

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
