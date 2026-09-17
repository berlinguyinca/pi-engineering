# Pi Engineering Orchestration Specification

This bundle defines the next architecture for **Pi Engineering**: one persistent parent Pi Engineering session orchestrating Pi child sessions/subagents and supervised subprocesses, integrated with the existing external **PI WEB** project (`jmfederico/pi-web`), with automatic engineering and review workflows that do not depend on slash commands.

## Non-negotiable architectural constraints

1. **PI WEB is external software.**
   - Upstream: `https://github.com/jmfederico/pi-web`
   - Integrate with it; do not reimplement it.
   - Prefer plugin/provider/session APIs and small upstream-compatible extensions.
   - Do not create a competing web UI.

2. **Pi Forge is out of scope.**
   - Do not install, integrate, evaluate, or implement Pi Forge.

3. **One parent Pi Engineering session is the developer-facing orchestrator.**
   - Child sessions/subagents and subprocesses are implementation details managed beneath it.
   - The user should normally interact only with the parent.

4. **No workflow depends on users remembering slash commands.**
   - `/engineer`, `/review`, `/parallel-review`, etc. may remain optional power-user/debug controls.
   - Normal-language intent must automatically select and enforce the appropriate workflow.

5. **The runtime, not the LLM, owns lifecycle state and completion.**
   - Code changes trigger validation/review policy.
   - Required gates cannot be skipped because a model forgot them.

6. **Use existing primitives before building new ones.**
   - PI WEB tracked/persistent sessions and worktrees where available.
   - Existing Pi child-session/subagent mechanisms.
   - Existing `pi-subagents` workflow, background, worktree, artifact, and review capabilities where they fit.
   - Standard supervised OS subprocesses for deterministic commands.

## Recommended implementation order

1. Mission model + durable event/state store.
2. Intent/policy router.
3. Unified execution broker.
4. DAG scheduler + subprocess supervisor.
5. Pi child-session/subagent adapter.
6. Worktree/write-domain isolation.
7. Validation + review + completion gates.
8. PI WEB integration.
9. Observability/metrics.
10. Adaptive routing, model selection, and optimization.

Read `00-master-spec.md` first.
