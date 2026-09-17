# 02 — Pi Dynamic Provider Integration

## Objective

Make `pi-engineering-harness` obtain model context/output limits from InferWeave and register them with Pi dynamically.

## Current Pi capability to leverage

Current Pi supports:

- dynamic provider registration;
- async provider discovery;
- `refreshModels`;
- per-model `contextWindow`;
- per-model `maxTokens`;
- model refresh without maintaining a static model table;
- `ctx.getContextUsage()`;
- native compaction using the model's `contextWindow`.

Use these mechanisms rather than editing Pi core.

## Provider design

Prefer a project/global Pi extension in the engineering harness that registers InferWeave as a provider.

Pseudo-code:

```ts
pi.registerProvider("inferweave", {
  name: "InferWeave",
  baseUrl,
  apiKey,
  api: "openai-completions",

  async refreshModels({ signal }) {
    const catalog = await capabilityClient.listModels({ signal });

    return catalog.map(m => ({
      id: m.id,
      name: m.name ?? m.id,
      reasoning: inferReasoning(m),
      input: inferInputs(m),
      cost: inferCost(m),

      contextWindow: resolveContextWindow(m),
      maxTokens: resolveMaxOutput(m),

      compat: resolveCompatibility(m)
    }));
  }
});
```

If the harness already has a richer complete `Provider`, integrate there rather than creating a duplicate provider.

## Context resolution precedence

For an InferWeave model:

```text
1. inferweave.context.guaranteed_routable_tokens
2. context_window
3. max_model_len
4. explicit harness per-model override
5. last-known-good discovered value (if within stale TTL)
6. conservative configured default (default recommendation: 128000)
```

Important:

- do **not** use 260K as the generic fallback;
- reject nonsensical values;
- record source/provenance for status/telemetry.

For direct vLLM model discovery behind InferWeave, support `max_model_len`.

## Output limit precedence

```text
1. max_output_tokens
2. max_tokens
3. inferweave.output.max_tokens
4. explicit harness override
5. conservative default
```

Always clamp output to `< contextWindow`.

## Refresh lifecycle

Refresh on:

- Pi/provider startup;
- explicit Pi model/catalog refresh;
- configurable TTL expiry;
- optional notification/event from InferWeave if such mechanism already exists;
- provider/model configuration reload.

Use `AbortSignal` for network calls.

Recommended defaults:

```yaml
inferweave:
  modelDiscovery:
    enabled: true
    refreshTtl: 60s
    requestTimeout: 5s
    staleIfError: 15m
```

Do not hammer `/v1/models` from every subagent. Use a process-local shared cache and conditional requests (`ETag`) where possible.

## Model switch behavior

When a Pi session switches model:

- subsequent context accounting must use the selected model's registered `contextWindow`;
- status UI updates immediately;
- native compaction uses the new model on subsequent threshold checks;
- if current context already exceeds the new model's safe working region, trigger/allow compaction before the next generation rather than sending an impossible request.

Add an integration test for large -> small model switching.

## Preserve operator overrides

Allow an explicit local override to win only when intentionally configured. The harness must show that an override is active.

Suggested config:

```yaml
inferweave:
  modelOverrides:
    qwen3.8-27b:
      contextWindow: 262144
      maxTokens: 32768
```

An override should be considered an operator assertion. Warn when it exceeds the server-advertised guaranteed context.

Default policy:

- smaller override: allowed;
- larger override: warning + require `allowUnsafeContextOverride: true`.

## Discovery diagnostics command

Add a command such as:

```text
/inferweave-context
```

or integrate into an existing diagnostics command.

Display:

```text
Model:                 qwen3.8-27b
Pi contextWindow:      262,144
Server guaranteed:     262,144
Server max routable:   1,048,576
Max output:            32,768
Capability source:     inferweave/v1/models
Generation:            c924...
Age:                   12s
Stale:                  no
Override:               none
```

## Status integration

Feed the existing engineering-harness status bar rather than creating a second competing footer.

Recommended compact rendering:

```text
qwen3.8-27b · ctx 143k/262k 55% · 31 tok/s · repo:branch · worktree
```

When capability is stale or fallback-based:

```text
ctx 88k/128k 69% ⚠fallback
```

## Error handling

- Network failure with fresh last-known-good: continue, show stale indicator.
- No model capability and no explicit override: conservative fallback + warning.
- Invalid server value: ignore invalid field, try next precedence source.
- Server advertises model but output limit missing: use configured safe default.
- Current context > newly reduced window: compact before generation or fail clearly.
- Never silently rewrite the user's conversation or truncate server-side.
