# Configuration Specification

## 1. Proposed configuration

Add a harness-level policy with provider/reason overrides.

Example:

```yaml
inference:
  retry:
    enabled: true

    admission:
      enabled: true
      max_attempts: 50
      max_elapsed_ms: 900000
      min_delay_ms: 500
      max_delay_ms: 120000
      base_backoff_ms: 2000
      jitter_ratio: 0.10
      honor_retry_after: true

      unknown_reason:
        mode: retry_if_server_delay_present

      reasons:
        queue_timeout:
          action: retry
          max_elapsed_ms: 900000

        caller_concurrency:
          action: retry
          max_elapsed_ms: 900000

        worker_saturated:
          action: retry
          max_elapsed_ms: 900000

        model_loading:
          action: retry
          max_elapsed_ms: 600000

        capacity_unavailable:
          action: retry_then_fallback
          fallback_after_ms: 180000

        quota_exhausted:
          action: fallback
```

Exact syntax SHOULD fit the harness's existing config conventions; the semantics above are normative.

## 2. Pi retry interaction

Avoid layered retry multiplication.

The harness MUST document which layer owns each retry class:

- InferWeave admission responses: harness/provider transport admission policy.
- Low-level network/transient transport retries: existing provider transport logic.
- High-level agent retry after a failed inference: existing Pi/harness agent retry logic.

Do not configure every layer to retry the same 429 independently, or an intended 10 retries can become 10 × 10 × 10 requests.

## 3. Defaults

Recommended production defaults:

```yaml
admission:
  max_attempts: 50
  max_elapsed_ms: 900000
  max_delay_ms: 120000
  honor_retry_after: true
```

The defaults MAY be more conservative initially behind a feature flag.

## 4. Environment overrides

If the harness supports env vars, expose a minimal emergency-operability set, for example:

```text
PI_HARNESS_ADMISSION_RETRY_ENABLED=true
PI_HARNESS_ADMISSION_MAX_ELAPSED_MS=900000
PI_HARNESS_ADMISSION_MAX_ATTEMPTS=50
PI_HARNESS_ADMISSION_MAX_DELAY_MS=120000
```

Prefer normal config files for full reason-specific policy.

## 5. Per-model overrides

Allow optional model-specific overrides without binding GPUs to models.

Example use case: a very large model that commonly requires a multi-GPU worker group may reasonably tolerate a longer queue wait than a small interactive model.

The configuration MUST describe workload retry behavior only; it MUST NOT encode static GPU placement, replica counts, or worker assignments. InferWeave remains responsible for model placement, residency, worker grouping, queueing, and scaling.
