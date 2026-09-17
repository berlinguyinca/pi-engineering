# Research Sources

Research performed 2026-09-14.

## Pi documentation

### Custom Providers
https://pi.dev/docs/latest/custom-provider

Relevant findings:

- Extensions can register custom providers.
- Extension factories can be async.
- Dynamic model discovery can fetch `/v1/models` and map `context_window` to Pi's `contextWindow`.
- Model definitions include `contextWindow` and `maxTokens`.

### Extensions
https://pi.dev/docs/latest/extensions

Relevant findings:

- Dynamic providers can implement `refreshModels`.
- Pi calls `refreshModels` during model refresh.
- `refreshModels` receives cancellation/network context.
- `ctx.getContextUsage()` exposes active-model context usage.
- `ctx.compact()` can trigger compaction programmatically.
- Footer/status integration is available through extension UI.

### Compaction & Branch Summarization
https://pi.dev/docs/latest/compaction

Relevant findings:

- Auto-compaction threshold is:
  `contextTokens > contextWindow - reserveTokens`
- Default `reserveTokens` is 16,384.
- Default `keepRecentTokens` is 20,000.
- Per-model compaction overrides exist.
- Model switches affect subsequent compaction settings/checks.
- Pi provides overflow-recovery and compaction lifecycle hooks.

### Custom Models
https://pi.dev/docs/latest/models

Relevant findings:

- Pi model metadata has `contextWindow`, default 128,000 when omitted.
- Pi model metadata has `maxTokens`, default 16,384 when omitted.
- `modelOverrides` can change `contextWindow` and `maxTokens`.
- Local/OpenAI-compatible servers are supported.

### RPC / context usage
https://pi.dev/docs/latest/rpc

Relevant finding:

- `contextUsage` represents the active current context-window estimate used by Pi for compaction/footer display.

## vLLM documentation

### Model configuration
https://docs.vllm.ai/en/latest/api/vllm/config/model/

Relevant findings:

- `max_model_len` is the model context length including prompt and output.
- If not explicitly configured it can be derived from model config.
- `--max-model-len ... auto` can select the largest value that fits available GPU memory.

### OpenAI model serving implementation
https://docs.vllm.ai/en/stable/api/vllm/entrypoints/openai/models/serving/

Relevant finding:

- vLLM's model list builds model cards with `max_model_len` taken from the active model configuration.

### OpenAI-compatible server
https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server/

Relevant finding:

- vLLM exposes OpenAI-compatible inference APIs, making it appropriate for InferWeave to normalize runtime-specific extensions while preserving compatibility.

## Design conclusions drawn from research

1. Pi already has the primitives needed for dynamic context discovery; upstream Pi changes should not be the default plan.
2. Correctly registering `contextWindow` makes Pi's native compaction model-aware.
3. vLLM can provide the actual deployment context limit, so InferWeave should prefer runtime introspection over static model-name tables.
4. Model context capability and admission reservation are different concepts and must be separately represented.
5. A session affinity/KV cache lifetime should not equal a caller-concurrency permit lifetime.
