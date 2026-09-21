# Milestone: InferWeave context capabilities in the harness

## What landed

| Surface | Change |
| --- | --- |
| `src/context/capability.ts` | Pure normalization + the spec's context precedence, with a 128 000 floor and an explicit ban-list for the retired 260K/262 144 fallbacks |
| `src/context/client.ts` | Shared capability client: TTL, ETag/`If-None-Match`, single-flight, `AbortSignal`, timeout, stale-if-error, `inspect()` diagnostics |
| `src/context/usage.ts` | `ctx 143k/262k 55%` reading + the model-switch decision (`none` / `compact` / `reject`) |
| `src/context/provider.ts` | `pi.registerProvider` payload with Pi's `refreshModels` hook, env config, operator overrides with an explicit unsafe flag, diagnostics renderer |
| `src/status/{state,layout,config,footer}.ts` | Context segment in the existing single-owner footer, its own priority (drops before the model), `PI_STATUS_BAR_SHOW_CONTEXT`, window follows model selection |
| `extensions/index.ts` | Provider registration, usage publishing, model-switch guard through Pi's native compaction, `/iw-context` |

## Why the floor is 128 000

262 144 is a legitimate model context limit for a 256K model and stays a
capability wherever it is one. What was wrong was using it as a *generic*
fallback: a client that has learned nothing about a model must assume less, not
the largest thing an old admission table happened to reserve.

## Verification

```bash
npx tsc --noEmit
npx biome check src/context src/status extensions/index.ts test/unit/context-*.test.ts
node --test test/unit/context-capability.test.ts test/unit/context-client.test.ts test/unit/context-status.test.ts
npm test
```

Tests cover: the capability parsing matrix, the full precedence chain including
expired data never expanding a window and last-known-good before the floor,
unsafe-override refusal, `maxTokens` clamping below the window, heterogeneity,
ETag revalidation and 304 reuse, single-flight under 25 concurrent callers,
stale→expired degradation, abort not hanging, a 404 not fabricating a window, the
rendered status line at wide and narrow widths, and model switches 1M→128K,
128K→1M, and into an impossible window.
