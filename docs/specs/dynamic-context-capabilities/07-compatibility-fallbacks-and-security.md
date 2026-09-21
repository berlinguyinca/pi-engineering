# 07 — Compatibility, Fallbacks, and Security

## Compatibility

The change must preserve normal OpenAI-compatible inference endpoints.

Extra fields in `/v1/models` are InferWeave extensions; clients that ignore them continue to work.

The Pi adapter must handle:

- enriched InferWeave response;
- vLLM-style `max_model_len`;
- minimal OpenAI-style model records with no context metadata.

## Fallback hierarchy

### Context window

```text
InferWeave guaranteed_routable_tokens
-> context_window
-> max_model_len
-> explicit safe override
-> fresh last-known-good
-> conservative default (recommended 128K)
```

Never:

```text
unknown -> 260K because that is what we used before
```

### Output window

```text
max_output_tokens
-> max_tokens
-> explicit override
-> safe default
```

Clamp to context.

## Stale model catalog

Suggested state:

- **fresh**: normal TTL;
- **stale-usable**: fetch failed but within `staleIfError`;
- **expired**: stale TTL elapsed.

Behavior:

- fresh: normal.
- stale-usable: continue with previous capability; status warns.
- expired: use explicit override or conservative fallback; do not expand context.

## Capability mismatch detection

If the gateway rejects a request as context-too-large even though Pi believed it fit:

- log both capability generations;
- refresh catalog immediately;
- do not blindly retry the same oversized request multiple times;
- compact or surface mismatch after refresh.

If the runtime reports a smaller actual limit than InferWeave catalog:

- quarantine/mark deployment unhealthy for that advertised capability;
- refresh capability;
- prevent repeated bad routing.

## Security

1. Authenticate capability endpoints consistently with inference endpoints unless intentionally public.
2. Treat context/output metadata as non-secret but do not expose private deployment topology to unauthorized clients.
3. Detailed capability endpoint may redact deployment IDs for ordinary users.
4. Server never trusts client-provided token counts for safety.
5. Stable session IDs must be tenant-scoped.
6. Rate-limit capability refresh if exposed publicly.
7. Validate all numeric metadata before arithmetic to prevent overflow/DoS.
8. Cap requested output server-side regardless of client claim.
9. Never include prompt contents in generic metrics/logs.

## Backward compatibility with existing Pi settings

- Respect existing `models.json` and harness overrides.
- Do not destructively rewrite user config on startup.
- Server discovery should be an overlay/source in the provider layer.
- Clearly display when local config overrides discovered server limits.

## Feature flags

Recommended:

```yaml
features:
  dynamicModelCapabilities: true
  weightedContextAdmission: false
  softKvLeases: false
```

This allows staged activation and rollback.

## Rollback

A rollback may disable weighted admission while keeping capability discovery.

Do not restore a fixed 260K reservation as the only rollback path. Provide a configurable conservative reservation policy if weighted accounting must be temporarily disabled.
