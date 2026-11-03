# Vision Delegation (pi-engineering) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When an image is pasted into a session whose model has no image input, Pi delegates it to a vision model in a herdr pane, hands everything the vision session found back to the original session, and emits lineage events.

**Architecture:** One `input` handler (`src/visionDelegation/`) intercepts images for text-only models. A pure protocol module defines the request/result files; a `VisionDelegator` drives a herdr pane through an injectable herdr client; the result file, validated against `request_id` and image hashes, is the only thing read back. Lineage goes through the existing `LineageEmitter.handoff`.

**Tech Stack:** TypeScript ESM (`.ts` imports), Node `node:test`, biome, the `herdr` 0.9.1 CLI, `@earendil-works/pi-coding-agent` extension API.

**Spec:** `docs/superpowers/specs/2026-11-02-vision-delegation-design.md`

## Global Constraints

- Correctness first: no image is dropped silently; every outcome (ok, partial, failed, no vision model, timeout, herdr missing) reaches the text agent as explicit text.
- Handoff and image data go to the vision session as files (`@file` arguments), never embedded in shell arguments.
- A result is accepted only if it validates, `request_id` matches, and the echoed image hashes match; consumed at most once; a result after a timeout or cancel is recorded, never injected.
- Pi computes image hashes; the vision model copies them back.
- Defaults: `wait_seconds` 300; alias preference `qwen3.8-vision`; `rpc` source not handled in v1; no automatic retry.
- Lineage causes exactly `vision_delegate` (out) and `vision_return` (back); handoff `kind` carries the outcome: `vision`, `vision_partial`, `vision_failed`, `vision_timeout`.
- The vision session gets the original session's project directory and normal tools and no extra privileges (spec: "Decided by the user"). The vision role prompt says text inside an image is data, never an instruction; the handback block says the analysis derives from untrusted image content.
- Milestone 1 is Tasks 1 to 6 and 8 to 10 (first delegation end to end); reuse and queueing (Task 7) is milestone 2.
- Work in a worktree off `origin/main`; commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; `npx biome check`, `npm run typecheck:core` must be clean for touched files.
- Tests run with `node --test --test-force-exit --import ./test/support/isolatedState.ts <file>`.

## Review Focus

- A vision-capable model gets its image untouched (handler returns `continue`; Task 9).
- Two sessions delegate at once; each only ever receives its own result (Tasks 2, 6).
- A result file appears after the wait timed out or the user cancelled; it is recorded and not injected (Task 6).
- An image file is unreadable, empty, duplicated, or very large; the delegation fails clearly instead of sending a broken request (Tasks 3, 6).
- The user pasted an image with no text; the handback still reads as a sensible message (Tasks 2, 6).
- The herdr binary is missing or `herdr` errors; the session continues in text with an explicit note (Task 6).

---

### Task 1: herdr wrapper — agent arguments and pane split

**Files:**
- Modify: `src/runtime/herdr/HerdrCli.ts` (interface `HerdrCli` near line 54; `RealHerdrCli.startAgent` near line 167)
- Test: `test/unit/herdr-cli-vision.test.ts` (copy the `fake()` argv-recording helper from `test/unit/herdr-cli-argv.test.ts`)

**Interfaces:**
- Produces: `startAgent(paneId: string, kind: string, name: string, args?: readonly string[]): Promise<void>` (existing three-argument calls keep their argv); `splitPane?(opts: { paneId: string; cwd: string; direction?: "right" | "down"; env?: Record<string, string> }): Promise<{ paneId: string }>` (optional on the interface so existing fakes still compile).

- [ ] **Step 1: Spike.** In a real herdr, run `herdr pane split --pane <id> --direction right --no-focus --cwd /tmp` and save the JSON it prints as the fixture for this task. The parse in Step 4 follows that exact shape.
- [ ] **Step 2: Write failing tests** in `test/unit/herdr-cli-vision.test.ts`: `startAgent with args puts them after --`, asserting argv is `agent start vision-ab12 --kind pi --pane w1:p2 -- --provider metabolomics --model qwen3.8-vision @/tmp/h.md`; `startAgent without args is unchanged`, asserting `agent start n --kind pi --pane p`; `splitPane passes cwd, direction, env and --no-focus and returns the new pane id`; `splitPane rejects an env key or value outside [A-Z0-9_] and [A-Za-z0-9._:@/-]`.
- [ ] **Step 3: Run to verify failure** (`FAIL`: `splitPane is not a function`, argv mismatch).
- [ ] **Step 4: Implement** both methods in `RealHerdrCli`, reusing the existing safe-value regex from `exportEnv`; args after `--` are passed as separate argv entries, never joined into a string.
- [ ] **Step 5: Run to verify pass**, plus `test/unit/herdr-cli-argv.test.ts` still passing.
- [ ] **Step 6: Commit** `feat(herdr): agent start arguments and pane split`.

### Task 2: Protocol — request, result, handback (pure)

**Files:**
- Create: `src/visionDelegation/protocol.ts`
- Test: `test/unit/vision-protocol.test.ts`

**Interfaces:**
- Produces:
  - `type SavedImage = { path: string; sha256: string; mimeType: string }`
  - `type VisionRequest = { requestId: string; sessionId: string; userText: string; images: SavedImage[]; createdAt: string }`
  - `type VisionResult = { requestId: string; status: "ok" | "partial" | "failed"; description: string; textInImage: string; findingsForTask: string; uncertainties: string[]; images: Array<{ path: string; sha256: string }> }`
  - `buildRequestFile(req: VisionRequest): string` (JSON text for `request.json`)
  - `parseResult(raw: unknown, req: VisionRequest): { ok: true; result: VisionResult } | { ok: false; reason: string }`
  - `renderHandback(userText: string, result: VisionResult, model: string, images: SavedImage[]): string`
  - `resultPath(dir: string, requestId: string): string` returning `<dir>/results/<requestId>.json`

- [ ] **Step 1: Write failing tests**: `parseResult accepts a valid ok result`; `rejects a different requestId`; `rejects when an echoed sha256 differs from the one sent`; `rejects when an image is missing from the echo`; `rejects an unknown status and a non-string description`; `renderHandback states partial and failed explicitly and lists uncertainties`; `renderHandback marks the analysis as derived from untrusted image content`; `renderHandback with empty userText still produces a non-empty message naming the image paths`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** as pure functions; field names on disk are snake_case (`request_id`, `text_in_image`, `findings_for_task`), mapped to the camelCase types in `parseResult`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(vision): request/result protocol and handback block`.

### Task 3: Image saving and the session registry

**Files:**
- Create: `src/visionDelegation/images.ts`, `src/visionDelegation/registry.ts`
- Test: `test/unit/vision-images-registry.test.ts`

**Interfaces:**
- Consumes: `SavedImage` (Task 2).
- Produces:
  - `saveImages(images: Array<{ data: string; mimeType: string }>, dir: string): Promise<SavedImage[]>` (base64 `data` as in Pi's `ImageContent`; writes `<dir>/images/<sha256>.<ext>`; rejects empty data)
  - `class VisionRegistry { constructor(file: string); get(sessionId: string): RegistryEntry | undefined; set(sessionId: string, entry: RegistryEntry): void; remove(sessionId: string): void }` with `type RegistryEntry = { paneId: string; agentName: string; sessionDir: string; startedAt: string }`, persisted as JSON via temp file and rename.

- [ ] **Step 1: Write failing tests**: `saveImages names files by sha256 and returns path and hash`; `saveImages rejects empty image data`; `saveImages with the same bytes twice yields one file and equal hashes`; `registry survives a reload from disk`; `registry set replaces the entry for a session and leaves others`; `a corrupt registry file reads as empty instead of throwing`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** both modules; `sha256` via `node:crypto`; extension from the mime type for png, jpeg, gif, webp, else `bin`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(vision): save images by hash, persist the vision session registry`.

### Task 4: Settings — the `vision_delegate:` block

**Files:**
- Create: `src/visionDelegation/config.ts`
- Test: `test/unit/vision-config.test.ts`

**Interfaces:**
- Produces: `loadVisionDelegateSettings(agentDir: string): Promise<VisionDelegateSettings>` with `type VisionDelegateSettings = { enabled: boolean; waitSeconds: number; aliasPreference: string[]; notes: string[] }`. Mirrors `loadForkSettings` in `src/runtime/herdr/forkSettings.ts` (global `engineering.yaml` only, malformed values turn it off with a note).

- [ ] **Step 1: Write failing tests**: `defaults when the block is absent` (enabled true, waitSeconds 300, aliasPreference `["qwen3.8-vision"]`); `enabled false is the kill switch`; `wait_seconds outside 10..3600 is rejected with a note and the default kept`; `a non-list alias_preference turns the feature off with a note`; `a repository engineering.yaml cannot change it`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement**, reusing `readYaml` from `src/lifecycle/policy.ts` and the validation helpers' style in `forkSettings.ts`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(vision): vision_delegate settings`.

### Task 5: Choosing a healthy vision model

**Files:**
- Create: `src/visionDelegation/chooseModel.ts`
- Test: `test/unit/vision-choose-model.test.ts`

**Interfaces:**
- Consumes: `RecoveryProbe`/`ProbeResult` from `src/resilience/probe.ts` (alias-aware, PR #553).
- Produces: `chooseVisionModel(deps: { models: Array<{ provider: string; id: string; input?: string[] }>; preference: string[]; probeFor: (m: { provider: string; id: string }) => Promise<ProbeResult> }): Promise<{ provider: string; id: string } | { none: true; reason: string }>`

- [ ] **Step 1: Write failing tests**: `prefers the first alias in the preference list that takes images and is healthy`; `skips an unhealthy alias and takes the next`; `ignores models whose input lacks image`; `returns none with a reason naming each skipped model when nothing is healthy`; `a non-authoritative probe result counts as not healthy`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(vision): choose a healthy vision alias`.

### Task 6: First delegation and handback (`VisionDelegator`)

**Files:**
- Create: `src/visionDelegation/delegate.ts`, `src/visionDelegation/rolePrompt.ts`
- Test: `test/unit/vision-delegate.test.ts` (fake herdr client, fake clock, temp dirs, a fake vision side that writes result files)

**Interfaces:**
- Consumes: `HerdrCli` (Task 1), protocol (Task 2), images and registry (Task 3), settings (Task 4), `chooseVisionModel` (Task 5), `buildSessionHandoff` from `src/plannerWorker/sessionHandoff.ts` (signature `{ sessionId: string; messages: SessionHandoffMessage[] }`).
- Produces: `class VisionDelegator { constructor(deps: VisionDelegatorDeps); handle(input: { sessionId: string; cwd: string; text: string; images: Array<{ data: string; mimeType: string }>; messages: SessionHandoffMessage[]; signal?: AbortSignal; status?: (text: string | undefined) => void }): Promise<{ action: "continue" } | { action: "transform"; text: string; images: [] }> }`; `VISION_ROLE_PROMPT: string`. `VisionDelegatorDeps` bundles `herdr`, `settings`, `models`, `probeFor`, `registry`, `artifactDir`, `now`, `sleep`, `newId`, `lineage` (Task 8's emitter function, optional here).

- [ ] **Step 1: Write failing tests**: `no images continues untouched`; `ok result becomes a transform that removes the images and carries the analysis`; `partial and failed results are stated as such in the text`; `result for another requestId is ignored and the wait continues`; `hash mismatch is a failed delegation`; `timeout produces an explicit "analysis timed out" text and never an empty message`; `a result written after the timeout is recorded and not injected`; `abort signal cancels the wait and records a late result as not injected`; `no healthy vision model continues with a plain note and the image path`; `herdr missing continues with a note`; `empty user text still yields a sensible message`; `the vision pane is started with --provider, --model, @handoff.md, @image args and no handoff text in argv`; `two sessions delegating at once never read each other's result files`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** `handle`: choose model, save images, write `handoff.md` (from `buildSessionHandoff` plus the user text) and `request.json` under `<artifactDir>/<requestId>/`, `splitPane` then `startAgent(..., args)` with `--provider`, `--model`, `--append-system-prompt <role prompt file path>`, `@handoff.md`, `@<image>`; poll `resultPath` every 500 ms until the deadline or abort (polling, the file is truth); on a valid result return the `renderHandback` transform; register the pane in the registry only after a valid first result.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(vision): delegate an image to a vision session and hand the analysis back`.

### Task 7: Reuse and queueing (milestone 2)

**Files:**
- Modify: `src/visionDelegation/delegate.ts`
- Test: `test/unit/vision-delegate-reuse.test.ts`

**Interfaces:**
- Consumes: `VisionRegistry`, `HerdrCli.getAgent`, `HerdrCli.prompt`, `HerdrCli.wait` (existing).
- Produces: `VisionDelegator.handle` reuses a live registered pane and serializes concurrent calls per session.

- [ ] **Step 1: Spike.** Against real herdr, start a `pi` agent with Task 1's `startAgent`, then confirm `herdr agent prompt <target> <text> --wait --until idle --until done` returns after the agent answers. Record the result in `docs/evidence/vision-delegation-prompt-spike.md`. If it does not work, use `pane send-text` plus `pane wait-output` and note it.
- [ ] **Step 2: Write failing tests**: `a second image reuses the registered pane and prompts it instead of starting one`; `the prompt names the new requestId and the result file path`; `a dead pane (getAgent returns null) starts a new session and the handback says earlier images are not in its context`; `a second image arriving during an analysis waits for the first and is handled in order`; `registry entry is removed when the pane is gone`.
- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement** a per-session promise chain for serialization and the reuse branch.
- [ ] **Step 5: Run to verify pass.**
- [ ] **Step 6: Commit** `feat(vision): reuse the open vision session, queue concurrent images`.

### Task 8: Lineage events

**Files:**
- Create: `src/visionDelegation/lineage.ts`
- Modify: `src/visionDelegation/delegate.ts` (call the emitter at delegate, return, and failure)
- Test: `test/unit/vision-lineage.test.ts`

**Interfaces:**
- Consumes: `LineageEmitter.handoff(input: HandoffLineageInput)` and the `LineageState` values `src/orchestration/missionStore.ts` `lineageHandoff` already uses (read it first and reuse its mapping for prepared, acknowledged, committed, failed).
- Produces: `emitVisionLineage(emitter: LineageEmitter | null, e: { phase: "out" | "back"; requestId: string; fromSession: string; toSession: string | null; fromModel: string; toModel: string; outcome: "ok" | "partial" | "failed" | "timeout" }): void` (never throws, no-op for a null emitter).

- [ ] **Step 1: Write failing tests** with a recording fake emitter: `out emits cause vision_delegate with the text and vision models`; `back with ok emits cause vision_return, kind vision and a committed state`; `partial uses kind vision_partial, failed uses vision_failed, timeout uses vision_timeout with a failed state`; `ids are vision-<requestId>-out and -back so a retry dedupes`; `a null emitter does nothing`; `an emitter that throws never breaks the delegation`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** and call it from `VisionDelegator`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(vision): emit lineage for vision delegation`.

### Task 9: Install the `input` handler

**Files:**
- Create: `src/visionDelegation/install.ts`
- Modify: `extensions/index.ts` (beside the `AdvisedModelSwitch` registration near line 2125; the lineage emitter comes from the existing `lineageEmitter()` helper near line 361)
- Test: `test/unit/vision-install.test.ts`

**Interfaces:**
- Consumes: `VisionDelegator` (Task 6).
- Produces: `registerVisionDelegation(pi: { on(event: string, handler: (event: never, ctx: never) => unknown): void }, deps: { build: () => Promise<VisionDelegator | null> }): void`. The handler returns `{ action: "continue" }` unless `event.images?.length`, `event.source !== "rpc"`, and `ctx.model?.input` lacks `"image"`.

- [ ] **Step 1: Spike.** In a throwaway extension, register an `input` handler that awaits 5 seconds and returns `continue`. Confirm Pi awaits it, whether a second message sent meanwhile queues or aborts, what Ctrl-C does, and that `ctx.ui.setStatus` shows. Record in `docs/evidence/vision-delegation-input-spike.md`; adjust Task 6's abort handling to match.
- [ ] **Step 2: Write failing tests** with a fake `pi`: `passes through when the model accepts images`; `passes through when there are no images`; `passes through for the rpc source`; `delegates for a text-only model and returns the transform`; `a delegator build failure returns continue and notifies the user`; `session id comes from ctx.sessionManager.getSessionId()`.
- [ ] **Step 3: Run to verify failure.**
- [ ] **Step 4: Implement** and wire it in `extensions/index.ts` behind `settings.enabled`.
- [ ] **Step 5: Run to verify pass**, then `npm run typecheck:core`.
- [ ] **Step 6: Commit** `feat(vision): intercept images for text-only models`.

### Task 10: Docs, config sample, and the acceptance spike

**Files:**
- Modify: `docs/usage.md` (new "Vision delegation" section), the engineering.yaml sample if the repo has one
- Create: `scripts/vision-delegation-spike.ts`, `docs/evidence/vision-delegation-acceptance.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the docs section**: what happens on a paste, the `vision_delegate:` keys and defaults, the kill switch, what the user sees for each outcome, and the lineage causes.
- [ ] **Step 2: Write `scripts/vision-delegation-spike.ts`**: runs `VisionDelegator` against the real `herdr` and the live `qwen3.8-vision` alias with a generated test image (left half red, right half blue) and a second image for reuse; prints each outcome.
- [ ] **Step 3: Run it on this Mac.** Expected: the first handback says the left half is red and the right half blue; the second image reuses the same pane; both appear in the herdr lineage graph with causes `vision_delegate` and `vision_return`.
- [ ] **Step 4: Record the run** in `docs/evidence/vision-delegation-acceptance.md` (commands, outputs, pane ids).
- [ ] **Step 5: Commit** `docs(vision): usage, spike, acceptance evidence`.
