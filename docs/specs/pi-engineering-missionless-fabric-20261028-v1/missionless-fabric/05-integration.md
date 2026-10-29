# 05 — Ecosystem integrations

## Herdr dashboard / room / graph
Audit active Herdr room, connected agent graph, collaboration terminal and task timeline work. Reuse existing event transport, fork lineage, graph projections, stream IDs and authorization. For each task the graph stores sessions, agents, handoff edges, plans, artifacts, git references, PR/CI and verification. The graph is queryable from terminal, dashboard and phone, and never restricted to one agent or one original mission.

## Planning
Single canonical optional `Plan` artifact shared among Pi, Claude, Codex and OpenCode. Import/export only through native provider capabilities where available. Local Herdr Plannotator optional *after plan exists*. Plans can be versioned, linked to decisions and acceptance criteria; executing one step needn't require whole-plan approval.

## Personal assistant
Attach to Herdr as an authorized non-coding actor with limited abilities: read task projections, correlate email/attachments with tasks, create draft artifact, file issues, propose task to coding room, summarize CI/PR. Existing assistant implementation is integration owner. External send, merge or deployment follow explicit permissions; never grant email text imperative authority over code actions.

## InferWeave / Slurm
Pi Engineering owns work objective, dependency and execution evidence. InferWeave owns inference model routing, rate limits, admission and queue status. Slurm/fabric owns worker resources where applicable. Structured waits should be surfaced and capacity-aware scheduling used, not layered retry loops. Support heterogenous GPUs/models and dynamic slots; no static per-model worker requirement.

## Artifacts and external collaborators
Use existing Libre WebUI Artifact Studio; artifacts authored via CLI/Pi slash commands, web read-only viewer/sharing/feedback, guest access under scoped policy. Preserve S3 routing storage integration rather than duplicating blobs. Artifact refs are first-class graph nodes with immutable provenance and correct access control.

## Cross-repository work rule
For any module owned by Herdr/InferWeave/assistant/Artifact Studio, change owner repo via explicit interface contracts and coordinated PRs. Do not embed a clone in pi-engineering. Reuse the existing `/summary` skill, model role pins, shared OpenViking retrieval, status bar, ledger, watchdog and worker hooks after fresh audit.
