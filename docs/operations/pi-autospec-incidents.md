# Pi–AutoSpec Incident Handoff

The first incident-resolution slice is opt-in at the Pi lifecycle seam. Supply
an `IncidentController` with the shared event store and an
`AutoSpecIncidentSink` publisher, then pass repository identity through
`incidentContext` when constructing `AgentProgressSupervisor`.

Prevented loops are persisted as `incident.detected` events before the sink is
called. Duplicate fingerprints are suppressed. If AutoSpec is unavailable, the
event remains in the event store and the controller returns `publish_failed` so
the delivery loop can retry it later.

The AutoSpec dry-run command is:

```text
autospec incident ingest \
  --repo OWNER/REPO \
  --event-file /path/to/event.json \
  --dry-run --json
```

Dry-run validates the versioned `agent_failure` event and returns the projected
issue, labels, fingerprint, and debugger dispatch without contacting GitHub.
Live ingestion deduplicates open `origin:pi-incident` issues by the stable
fingerprint marker before creating a new issue.

The current slice does not merge PRs or deploy code. It produces the durable,
safe handoff required for the next AutoSpec autonomous-run integration slice.
