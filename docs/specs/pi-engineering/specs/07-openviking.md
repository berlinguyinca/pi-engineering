# 07 OpenViking

> **Amended — the role is Hindsight's.** Everything this spec requires (mandatory
> shared durable memory, per-session identity over a shared project resource,
> bootstrap + on-demand retrieval, boundary commits, explicit offline outbox,
> secret redaction, promotion only of validated observations) is implemented, but
> the *transport* named here is retired: `OpenVikingProvider`, the
> `PI_OPENVIKING_*` configuration, the interactive setup dialog and the
> `services/openviking` service were deleted. Durable memory is **Hindsight,
> reached through the `herdr-memory` CLI** (`durable.kind: hindsight`,
> `PI_HINDSIGHT_*`); `openviking` fails configuration validation. See
> [GAP_MATRIX §07](../GAP_MATRIX.md) for the scored status
> and [usage: sharing memory](../../../usage.md#sharing-memory-across-several-workers)
> for the current configuration. Requirements below are kept verbatim as the
> normative contract this spec pack was scored against. This file deviates from
> `MANIFEST.json` for exactly this banner; [AMENDMENTS.md](../AMENDMENTS.md)
> records both hashes and where the original bytes live.
Mandatory shared durable memory. Distinct OpenViking session per Pi parent/child, shared canonical project resource. Bootstrap ~4k–8k relevant tokens, retrieve on demand, commit at phase/run boundaries, refresh after meaningful commits. Provide search/recall/remember/status. Explicit offline outbox only. Redact secrets. Prefer OpenViking Git ingestion/watch over custom indexing.
