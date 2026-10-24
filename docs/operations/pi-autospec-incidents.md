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
Live ingestion deduplicates `origin:pi-incident` issues by the stable
fingerprint marker before creating a new issue, then dispatches the existing
issue-scoped autonomous conductor. That conductor owns the verified PR and
merge gates. Pi's `DeploymentController` provides the
deployment boundary for a configured adapter: it requires a distinct previous
artifact, promotes the new version, runs health checks, and rolls back on
failure while recording `deployment.*` evidence. It does not select or invoke
a production command by itself.
