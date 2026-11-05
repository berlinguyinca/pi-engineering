# H01 — Inventory existing Herdr telemetry surfaces

Task authority: canonicalHash(parseTaskManifest(manifest).manifest) over
docs/specs/harness-reliability-bootstrap-20261103/H01/fixtures/manifest.json (printed by the CLI at stamp time).
Parent handoff: docs/specs/harness-reliability-bootstrap-20261103/R08/R08.handoff.json (sha256:c0a7d0683409f56cb796ef9956ba3e4300216f6b09ca24461af400716603dd51, status PASS, resultSha 12d47c2f5658d29d48fc9346957f53966507d261).
**This unit is in the `herdr` repo (`berlinguyinca/herdr-engineering`), not `pi`.** Your base commit is `b5e6903c2f49c462c3e91528c42b5547137921ab` (`origin/main`) and your worktree is rooted there. Mode: herdr-ui.

## Objective (plan delta, verbatim)
Identify actual mission timeline endpoints, web components, naming conventions, existing error and APS signals; no UI code.
Evidence: Precise integration map with evidence of reusable components.

## What this unit is for (and what it is explicitly not)
The next units in this phase put harness-side mission/worker/retry/incident telemetry onto Herdr's existing visualization. Before any of that, this unit is a **read-only survey written down**: every claim must name the file and line you read it from, so a later unit can integrate without re-discovering the surface. **Write no UI code, no component, no CSS, no JS, no Python, no test** — 120 lines, one file, nothing else.

## How to work (read-only commands only)
`grep`/`rg` and `sed -n` inside this worktree. Do not start servers, do not run the test suite, do not open network connections, do not run anything under `deploy/`, do not `pip install`. If a fact needs a running service, write "needs verification at integration time" instead of guessing.

## Deliverable — `docs/specs/harness-reliability-bootstrap/HERDR_SURFACES.md` (**new**, ≤120 lines)
Five titled sections, each entry as `claim — `path:line`` (relative path + line number, nothing claimed without one). Line numbers must be real: quote the identifier you saw at that line.

1. **Mission timeline endpoints.** Start from `herdr_engineering/control_plane/api.py` and `herdr_engineering/control_plane/repo.py` (`mission_timeline` lives in `repo.py`; `_with_collab_tasks` in `api.py` wraps a `timeline`) and enumerate each route or handler a timeline consumer would call: method/path or function name, what it returns for a mission, and how a mission is keyed (`mission_key` vs `mission_id` vs `entity_id`). Include the ingest side (`control_plane/ingest.py`, `_ingest_mission`) and the state derivation (`control_plane/graph_ingest.py`, `_mission_state`) only as far as it explains what a timeline row means.
2. **Web components / browser-facing assets.** Inventory what actually ships to a browser today, starting from `deploy/herdr-cp-feed-plugin/` (e.g. `session-helpers.js`, `enrich.js`, `emit.js`, `git-metadata.js`, `host-config.js`, `report-worker.js`, plus their `.test.js` siblings). For each: what it renders or formats, its export shape, and whether it is reusable as-is for harness telemetry (state yes/no and why in ≤10 words). Say plainly if the surface is *not* custom elements, and name the convention it does use.
3. **Naming conventions.** Record the conventions a new producer must follow, with a `path:line` per rule: Python module/function style (`snake_case` modules and functions), how entity ids are formed (`entity_id`, `mission_key`, `event_type`), payload field casing (camelCase vs snake_case in JSON payloads), the event-type vocabulary (`_ingest_mission`, `_mission_state`, `mission_lineage_events`), and the JS-side convention inside the feed plugin. Where two conventions coexist (Python snake_case vs JSON camelCase), say which boundary separates them.
4. **Existing error signals.** Enumerate what the control plane already accepts or emits for failures: `error_code` (`herdr_engineering/pi_recovery.py`), `errorCode` as used in `herdr_engineering/pi_recovery_verification.py` (`:247`), any `retry`/`attempt` fields in payloads, and the exception types that reach the API boundary (`ReportError` in `summary_report.py`, `PublicationRejected` in `mission_activity_feed.py`, `GitHubAuthError` in `github_auth.py`, `CheckpointError` in `checkpoint.py`). For each: does it reach the timeline/API, or stop at a log? — that distinction is the point.
5. **Existing APS signals.** What the APS/autospec side already publishes that a mission timeline can render: `herdr_engineering/pi_autospec.py` (`ingest_mission` `:66`, `ingest_worker` `:75`) and `herdr_engineering/mission_activity_feed.py` — field names, statuses, and the publish path. Note explicitly which of these carry worker-level detail (worker_id, status, retry) versus mission-level only.

Close with two short lists: **Reusable as-is** (component/endpoint + one-line reason) and **Missing for harness telemetry** (what the bootstrap now produces that has no Herdr surface yet: per-attempt retry budget/circuit/replay-safety decisions, sanitized error fingerprints, incident evidence bundles, resolution verdicts — cite the pi-side modules by name only, no pi file paths' line numbers).

## Verify (must be green)
1. `git diff --check` (the plan's only verify command)
Also confirm `git show --name-only HEAD` lists exactly one file: `docs/specs/harness-reliability-bootstrap/HERDR_SURFACES.md`.

## Report
Write `WORKER_REPORT.md` in the worktree root: `git diff --numstat b5e6903c2f49c462c3e91528c42b5547137921ab HEAD`, the exit code of `git diff --check`, the counts per section, and the single most surprising thing you found (one sentence). Commit as `docs(telemetry): inventory of existing Herdr mission, web and error surfaces (H01)`.
