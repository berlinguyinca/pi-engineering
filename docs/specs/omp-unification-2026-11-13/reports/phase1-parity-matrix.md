# Phase 1 — Parity and duplication matrix

Pinned: pi-engineering `5ab85965fce3f4343eff776ac23d11c1bc197799` (origin/main, 2026-11-13);
oh-my-pi `57263720c818ab3baaeb74bf415b03592b806ae0` (2026-11-14).
Sources: `phase1-pe-surface.md`, `phase1-omp-surface.md`, `phase1-baseline.md`, `skills-*.md`.
Verdict vocabulary: RETAIN (PE owns), DELEGATE (OMP owns, PE adapts), BRIDGE (adapter needed), UNKNOWN (not proven).
Nothing here claims runtime compatibility; compatibility is only established by executed tests (Phase 2+).

## Capability matrix

| Capability | Pi Engineering (evidence) | OMP (evidence) | Verdict |
|---|---|---|---|
| Durable event-sourced ledger | `.pi-eng/ledger.jsonl`, `authority_generation` fencing, `LedgerAuthorityStaleError` (`src/ledger/errors.ts:24`) | Session JSONL trees only; no hash-chained ledger | RETAIN |
| Leases / fencing / custody | SQLite `registry.db`, generation-fenced leases | pid marker file for isolation ownership; fencing hits in source are unrelated (OAuth refresh owner `packages/ai/src/auth/store.ts:121`) | RETAIN |
| Worktree safety | `safeGit`, primary-worktree guard, trash-not-delete janitor | Optional copy-on-write PAL (`crates/pi-iso`), delta merge; not git worktree | RETAIN (do not substitute PAL) |
| Mission orchestration, recovery | `/mission`, planner/worker, recovery quarantines torn tails | `task` tool + agent defs; cold-revive of non-isolated subagents | RETAIN |
| Worker session creation | `createAgentSession` (`src/workers/PiWorkerExecutor.ts:1677`), workers get empty skills/prompts/extensions (`:206-214`) | SDK `createAgentSession`, RPC `--mode rpc`, ACP | BRIDGE |
| Extension host API | `ExtensionAPI` from `@earendil-works/pi-*` 0.87.1 (~40 files; loose `as never` casts) | `(pi: ExtensionAPI)` factory; loader rewrites `@earendil-works/*` specifiers to host copies | BRIDGE (version-pin + capability probe) |
| Version/capability negotiation | none needed today (peer `*`) | RPC `negotiate_protocol` v1/v2 (tests: `rpc-output.test.ts:84`); extension API negotiation UNKNOWN | BRIDGE via RPC |
| Subagent spawn control | worker executor | `before_subagent_spawn` hook, can block/replace model (`test/task/task-spawn.test.ts:257`) | BRIDGE |
| Review | `/review`, independent reviewer, PR review | `/review` runs `reviewer` agent, structured verdict | UNKNOWN overlap; keep PE review authoritative |
| Deterministic verify | `/verify` | none identified | RETAIN |
| Tournament | `/tournament` | none identified | RETAIN |
| Hindsight memory | `herdr-memory` CLI (`src/blackhole/hindsight.ts`) | `memory.backend` off/local/hindsight/mnemopi/sharpshooter; HTTP server default :8888 | DELEGATE-NEVER-DUAL: one store per fact; UNKNOWN until Phase 5 |
| LSP / DAP | not a PE concern | full LSP client+mux, DAP | DELEGATE (candidate, optional) |
| Skills discovery/registry/lockfile | none (no SKILL.md; no `pi.skills`) | 9-provider precedence, `skills.lock.json` SHA-512 | DELEGATE |
| Offline one-model mode | required invariant | UNKNOWN | RETAIN, test in Phase 2 |

## Duplication ranking (candidate for eventual removal, Phase 7 only after parity tests)
1. Worker/session plumbing around `createAgentSession` — partial overlap, highest value, highest risk.
2. LSP-style helpers if any exist in PE (not found in the surface report: UNKNOWN).
3. Review prompt scaffolding — only if OMP reviewer reproduces PE's evidence contract.
Ledger, custody, fencing, worktree guards, verify, tournament have NO OMP equivalent and are never deletion candidates.

## Baseline (legacy, SHA 5ab85965, Node v22.22.3)
typecheck, lint, smoke, platform (120/120): exit 0. unit: 6898 pass / 0 fail / 5 skip (311 s).
integration: 1197 pass / 1 fail of 1198 (350 s); the failure `mission-reliability-foundation.test.ts:865` is a git
`.git/index.lock` race, 44/44 on rerun: FLAKY. Coverage: UNKNOWN (no coverage script).
Environment note: machine default Node is v26.3.0 which violates `engines` (`>=22.18 <26`); all PE runs need Node 22.

## Findings that change the plan
1. Spec archive is incomplete: only README, ONE_SHOT_PROMPT, spec 07 were present. Phases 1-7 follow the prompt text.
2. OMP ships 3 skills (spec said 2): `system-prompts` is additional. 18 other tracked SKILL.md files are test fixtures.
3. PE CI is Woodpecker (`.woodpecker/ci.yaml`), not GitHub Actions; it has lint, typecheck, unit, integration, smoke and
   roadmap-structural steps but NO coverage step, so the 80% coverage rule is not enforced. Not fixed here (out of scope); recorded as risk.
4. Worker sessions are deliberately skill-less (`roleResourceLoader`, context firewall). A skill pack would reach only the operator session unless that firewall is changed, which needs an explicit decision.
5. OMP skill auto-learn has no review gate and writes to the global dir: stays OFF in PE (spec experiment C).

## Unverified / UNKNOWN
OMP extension-API versioning; OMP review test coverage and whether OMP fake-server tests use mocks; PE `EventType` union head,
migration steps, sqlite binding, bodies of `/execute`, `/ledger`, `/challenge`; OMP offline single-model mode; skills registry signing/rollback.
