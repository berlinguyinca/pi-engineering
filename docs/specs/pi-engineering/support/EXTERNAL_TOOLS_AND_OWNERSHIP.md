# External Tools, Services, and Repository Ownership

This document is **normative**. The implementation agent MUST read it before making changes.

## Core rule

`pi-engineering` is an **integration/configuration/policy harness** around existing Pi ecosystem tools.

**DO NOT reimplement, vendor, clone, scaffold, or build replacements for external/upstream tools inside `pi-engineering`.**

When a requirement mentions an external tool, the local work is limited to the adapter, configuration, policy, extension, deployment reference, API/RPC client, event normalization, or integration needed to use that tool.

If an external tool lacks a required feature, first:
1. verify the feature is actually absent in the installed/current upstream version;
2. prefer configuration/plugin/extension/API integration;
3. document the gap;
4. only modify the external repository itself when that repository is explicitly in scope and the change belongs upstream.
Never silently recreate it in `pi-engineering`.

## Ownership matrix

| Component | Classification | Owner / source | What `pi-engineering` may implement | What it MUST NOT implement |
|---|---|---|---|---|
| Pi | EXTERNAL / UPSTREAM RUNTIME | Pi project/repository | extensions, configuration, policy hooks, adapters | a replacement Pi runtime |
| pi-subagents | EXTERNAL / UPSTREAM PACKAGE | pi-subagents project/package | configuration, role definitions, orchestration policy, adapters | custom replacement subagent/process framework, worker pool, duplicate FleetView |
| Pi Web | EXTERNAL / UPSTREAM TOOL | Pi Web project/package | configure, launch/connect, extension/plugin/integration if supported, deep links/API adapter | **Pi Web itself, a new Pi Web frontend/backend, a replacement web IDE** |
| Pi Forge | **OUT OF SCOPE** | none | nothing | do not inspect, install, integrate, configure, vendor, fork, or implement |
| Plannotator | EXTERNAL / UPSTREAM TOOL | Plannotator project/package | configuration, Docker deployment reference, API adapter, approval-policy integration | implement a replacement plan annotation UI/service |
| OpenViking | EXTERNAL SERVICE | `viking.metabolomics.us` / OpenViking | client integration, project/session mapping, retrieval/promotion policy, offline outbox | OpenViking server, vector DB, custom shared-memory server |
| Blackhole / pi-blackhole | EXTERNAL / UPSTREAM PACKAGE | pi-blackhole package | pin/configure/integrate/benchmark, promotion bridge | fork/reimplement Blackhole; shared Blackhole server/filesystem |
| InferWeave | EXTERNAL SYSTEM / PROVIDER | InferWeave repositories/services | provider adapter, capability discovery, session metadata, backpressure handling | GPU scheduler, model placement engine, InferWeave gateway/node runtime |
| AutoSpec | EXTERNAL SIBLING PROJECT | AutoSpec repository | adapter/integration contracts where local harness must call it | copy AutoSpec into pi-engineering; duplicate its spec/work-item engine |
| MCP servers | EXTERNAL SERVICES/TOOLS | individual MCP projects/services | registry, configuration, auth, capability/permission policy | reimplement domain MCP servers |
| Git | EXTERNAL TOOL | system | invoke/manage worktrees through safe abstraction | implement VCS |
| Docker/Compose | EXTERNAL TOOLING | system | Compose/configuration for local integration services | container runtime |
| PostgreSQL | EXTERNAL SERVICE | packaged dependency | schema/migrations/client for pi-engineering-owned runtime state | database server |
| Prometheus/OpenTelemetry/Grafana | EXTERNAL TOOLING | external projects | exporters/config/dashboards where needed | recreate telemetry platforms |

## What belongs in `pi-engineering`

Local implementation SHOULD focus on:
- engineering lifecycle policy;
- automatic review triggers and completion gates;
- role/model/tool policy;
- project registry/configuration;
- integration adapters for external tools;
- canonical Run/Task/Worker domain state not already owned upstream;
- normalized event ingestion/correlation;
- permission/capability policy;
- prompt/telemetry policy;
- external-tool health/capability discovery;
- orchestration conventions built **on** pi-subagents;
- configuration and deployment glue;
- tests proving integrations work together.

Before adding a substantial module, the implementation agent must answer:
> Is this integration/policy owned by pi-engineering, or am I rebuilding an external tool?

If the latter, stop and use/integrate the external tool instead.
