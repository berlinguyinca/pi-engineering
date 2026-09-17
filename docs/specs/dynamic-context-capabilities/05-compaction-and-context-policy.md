# 05 — Pi Compaction and Context Policy

## Objective

Use discovered model context windows to make Pi's context management accurate, while avoiding unnecessary custom compaction logic.

## Native Pi behavior

Pi auto-compaction is based on:

```text
contextTokens > contextWindow - reserveTokens
```

Therefore setting the correct per-model `contextWindow` already removes the biggest source of error.

Current Pi also supports:

- global `reserveTokens`;
- global `keepRecentTokens`;
- per-model compaction overrides;
- `ctx.getContextUsage()`;
- programmatic `ctx.compact()`;
- compaction lifecycle hooks.

## Phase 1 — required

Implement only what is necessary:

1. register correct dynamic `contextWindow`;
2. register correct `maxTokens`;
3. leave Pi native compaction enabled;
4. keep operator's existing compaction settings unless they are incompatible;
5. display context usage against discovered window;
6. test model switches and overflow recovery.

Do not duplicate Pi's built-in summarizer.

## Phase 2 — optional adaptive policy

Only add this if benchmarks show the fixed response reserve is inadequate across very different windows/output limits.

Policy goals:

- enough output headroom;
- compact before overflow;
- avoid needlessly compacting 1M models at 100K;
- preserve a reasonable recent working set.

Possible policy:

```text
desiredReserve =
    max(
        configuredMinReserve,
        modelDefaultOutputBudget * outputReserveMultiplier,
        floor(contextWindow * reserveRatio)
    )

desiredReserve = min(desiredReserve, configuredMaxReserve)
```

Example config:

```yaml
contextPolicy:
  mode: native
  adaptive:
    enabled: false
    minReserveTokens: 16384
    reserveRatio: 0.08
    outputReserveMultiplier: 1.25
    maxReserveTokens: 131072
```

Default remains `native` until measured evidence justifies adaptive behavior.

## Why not make percentage compaction mandatory now?

Pi's native mechanism is already context-window-aware. The primary bug is a wrong/static context capability and server reservation model, not the absence of percentage thresholds.

Avoid adding a second competing compaction trigger without evidence.

## Small-model switch

If current Pi usage is larger than a newly selected model window:

1. detect on model switch / before next run;
2. invoke native compaction if possible;
3. re-check usage;
4. if still impossible, fail before dispatch with an actionable message.

Never dispatch a known-oversized context and wait for the gateway to reject it.

## Compaction telemetry

Record:

- model/provider;
- context window;
- tokens before;
- trigger (`threshold`, `overflow`, manual, harness-policy);
- tokens/estimated usage after;
- duration;
- success/failure;
- capability generation active at compaction.

Do not record full prompts/summaries in metrics.

## Context status

Use Pi's `ctx.getContextUsage()` for local usage display.

Context percentage must use the same registered context window Pi is using for compaction.

When usage is estimated rather than reported, label it internally in diagnostics if the API exposes enough information.
