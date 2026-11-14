# Phase 2: OMP adapter compatibility spike

Pinned upstream: oh-my-pi `57263720c818ab3baaeb74bf415b03592b806ae0` (omp 18.20.0). Scope: opt-in capability negotiation, version pinning, typed fallback. No worker/session/ledger/lease/worktree changes.

## Design
`src/omp/` (not imported by any mission/worker code; default OFF):
- `types.ts` typed `CapabilityReport`, `OmpNegotiationResult = available | unavailable{reason}`, `UnavailableReason` (const object; repo uses `erasableSyntaxOnly`, so no `enum`).
- `manifest.ts` pin manifest (omp `>=18.20.0 <18.21.0`, protocols `[1,2]`), semver, `--version` parsing.
- `frames.ts` JSONL frame parse/decode (`ready`, `negotiate_protocol`).
- `report.ts` protocol selection (highest shared) and report building.
- `config.ts` flag `PI_ENGINEERING_OMP_ADAPTER=1` (default off), `PI_ENGINEERING_OMP_BIN` (default `omp`), `PI_ENGINEERING_OMP_TIMEOUT_MS` (default 15s).
- `negotiate.ts` `negotiateOmp` (runs `<bin> --version`, then `<bin> --mode rpc --no-session`, reads `ready`, sends `negotiate_protocol`, always reaps the child) and `negotiateOmpFromEnv` (returns `Unavailable{disabled}` without spawning when off). Never throws.

Failure reasons: disabled, binary_absent, timeout, version_unreadable, version_mismatch, protocol_mismatch, malformed_frame, crashed.

## Real frame shapes (observed from a real omp 18.20.0, not from mocks)
```
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864,"supportsBashExcludeFromContext":true}
-> {"id":"n1","type":"negotiate_protocol","protocolVersion":2}
<- {"id":"n1","type":"response","command":"negotiate_protocol","success":true,"data":{"protocolVersion":2}}
-> ...protocolVersion":3
<- {"id":"n2","type":"response","command":"negotiate_protocol","success":false,"error":"Unsupported RPC protocol version: 3"}
```
`omp --version` prints `omp/18.20.0`. The `ready` frame carries no omp version, hence the separate version probe. Other frames (`extension_ui_request`, `available_commands_update`) follow `ready` and are ignored by the adapter.

## Findings that change the plan
1. `omp --mode rpc` does NOT start without a default model: it exits with "No default model selected" before emitting `ready`. The claim "negotiate needs no API key" is only true in the narrow sense: a placeholder key env var (`ANTHROPIC_API_KEY=sk-dummy-not-used`) satisfies the startup check and no prompt is sent, so no model call happens. In production the adapter will run with the operator's real configured model; offline one-model mode needs a model configured for omp too (Phase 3/4 concern).
2. omp requires Bun >= 1.4.4 and the `pi_natives` native addon; startup fails without both.
3. Startup has side effects (reads/creates `~/.omp`, may emit widget frames); tests isolate with a temp `HOME` and cwd.

## Real omp sandbox (outside the PE repo)
- `~/IdeaProjects/omp-unification/omp-sandbox`: clone of the pinned commit, `bun install --frozen-lockfile --ignore-scripts` (298 packages, no scripts run).
- Bun 1.3.12 on the machine was too old; installed `bun@1.4.4` via npm with `--ignore-scripts` into `omp-sandbox-bun` (binary taken from `@oven/bun-darwin-aarch64`). No global changes.
- No native build: copied the prebuilt `pi_natives.darwin-arm64.node` from the published npm package `@oh-my-pi/pi-natives-darwin-arm64@18.20.0` (same version number as the pinned commit; NOT built from the pinned source, so binary provenance is "published 18.20.0 artifact"). It is a native library loaded by the launched RPC process; no upstream script was run.
- Launched only `cli.ts --mode rpc --no-session` and `--version`.

## Tests
Unit `test/unit/omp-adapter.test.ts` (8): semver/range boundaries, version output, frame decode (real frame text), negotiate req/resp, protocol selection, report, config default OFF, disabled-without-spawn.
Integration `test/integration/omp-adapter.test.ts` (8):
- always run, real processes: binary absent (nonexistent path), timeout (`sleep 60`, reaped), crash (exit 3 with stderr), unreadable version (`/bin/echo`), enabled flag with absent binary.
- gated on `OMP_BIN` (+ `OMP_BIN_ARGS`), skip reason "UNVERIFIED: OMP_BIN not set": real omp negotiates v2 and reports capabilities; real omp refused with `version_mismatch` (manifest 99.x); real omp refused with `protocol_mismatch` (empty accepted set).

Results (Node 22):
- Adapter unit: 8 pass / 0 fail.
- Adapter integration, `OMP_BIN` set to the sandbox bun + `cli.ts`: 8 pass / 0 fail / 0 skip (real omp 18.20.0).
- Adapter integration, `OMP_BIN` unset (CI default): 5 pass / 3 skip.
- typecheck: clean. lint (biome): clean.
- Full unit suite: 6911 tests, 6906 pass / 0 fail / 5 skip (baseline 6898 pass; +8 new).
- Full integration suite (OMP_BIN unset): 1206 tests, 1202 pass / 1 fail / 3 skip. The failure was `runtime-host-auto-reload.test.ts` "a commit does not reload while a tracked file is mid-edit" (not the baseline flaky test); it passes 12/12 in isolation both with and without this change, so it is a load-sensitive git-timing flake unrelated to `src/omp/`. The baseline flaky `mission-reliability-foundation.test.ts:865` did not fail this run.

## VERIFIED vs UNVERIFIED
VERIFIED (executed): ready+negotiate v2 handshake and capability report against real omp 18.20.0 (darwin-arm64, published native addon); version-range refusal and protocol-mismatch refusal against that real process; binary-absent, timeout, crash, unreadable-version fallbacks against real processes; default-OFF behavior.
UNVERIFIED: other omp versions (range upper bound is a policy, only 18.20.0 was run); Linux/other platforms; v1-only runtimes (the v1 path is unit-covered via selection logic only, no real v1 omp exists in range); behavior with a real configured model/auth; prebuilt-vs-source native addon equivalence; CI never exercises the real-omp tests (skipped without `OMP_BIN`).

## Rollback
Leave `PI_ENGINEERING_OMP_ADAPTER` unset (default): nothing in `src/omp/` is reachable from mission code. Full removal: revert the PR (new files only, no existing file modified).

## Risks
- Pin range is narrow by design; any omp bump needs manifest change plus rerun.
- Two sequential spawns per negotiation (~seconds on real omp); callers should cache the result.
- Frame schema is read from upstream source at the pin and one live run; upstream can change `ready` fields (unknown fields are ignored, required ones are validated).
