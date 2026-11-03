# Vision Delegation (herdr-engineering dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The herdr dashboard shows Pi's vision delegations as linked round trips with their outcome, model and duration, lets the user filter by cause, and counts delegations so "how often" is a number.

**Architecture:** Pi emits two handoff lineage nodes per delegation (see the Pi plan, Task 8). The backend (`handoff_lineage.py`) learns the two new causes and extracts a `vision` summary from the node; the dashboard views (`packages/handoffs-view.js`) render, filter and count them. Nothing here changes how other handoffs render.

**Tech Stack:** Python (pytest, `herdr_engineering/control_plane`), plain JS ES modules (`node --test`, `packages/*.test.js`), Markdown contract docs.

**Spec:** `docs/superpowers/specs/2026-11-02-vision-delegation-design.md` in the pi-engineering repository (section "Dashboard"). Companion plan: `2026-11-02-vision-delegation-pi.md` in the same directory.

## Global Constraints

- What Pi emits (fixed by the Pi plan): handoff node ids `vision-<requestId>-out` and `vision-<requestId>-back`; causes exactly `vision_delegate` (out) and `vision_return` (back); the handoff `kind` carries the outcome: `vision` (ok), `vision_partial`, `vision_failed`, `vision_timeout`; models are `from_model` (the text model) and `to_model` (the vision model).
- An image count is not carried by Pi's emit; do not show one.
- Durations come from the control plane's `first_seen_at` / `last_seen_at`, never Pi's clock; a node without them has no duration.
- Every rendered field is escaped; an unknown cause or kind still renders generically and never throws.
- Existing handoff behavior is unchanged: `context_pressure`, `quota_exhausted`, `phase_transition` rows and their tests keep passing.
- Work in a fresh worktree off `origin/main`. The checkout at `~/IdeaProjects/herdr-engineering` has uncommitted work and must not be touched.
- Commit trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Tests: `python -m pytest tests/control_plane/test_handoff_lineage.py` and `node --test packages/handoffs-view.test.js`.

## Review Focus

- An out node with no matching back node (the vision session never answered) renders as an open round trip, not an error (Task 3).
- A back node whose out node the caller may not read (visibility) renders alone (Task 3).
- A node with cause `vision_return` but an unknown kind renders with a generic outcome (Task 1).
- Two delegations for the same session at the same second are two round trips, not one (Task 3).
- Hostile markup in a model name or request id is escaped (Tasks 2, 3).

---

### Task 1: Contract and backend — causes and the `vision` summary

**Files:**
- Modify: `docs/contracts/lineage-events.md` (the handoff section), `herdr_engineering/control_plane/handoff_lineage.py` (`CAUSE_TEXT`, `row_from_node`)
- Test: `tests/control_plane/test_handoff_lineage.py`

**Interfaces:**
- Produces: `CAUSE_TEXT` entries for `vision_delegate` and `vision_return`; `_vision(handoff_id: str, cause: str | None, kind: str | None) -> dict | None` returning `{"request_id": str, "phase": "out" | "back", "outcome": "ok" | "partial" | "failed" | "timeout" | "unknown"}` or `None` when the cause is not a vision cause; `row_from_node` adds the key `vision` to a row only for vision causes.

- [ ] **Step 1: Write failing tests**: `a vision_delegate node reads as a switch from the text model to the vision model` (`model_change == "switched"`, goal text names vision); `a vision_return node with kind vision_partial reports outcome partial`; `kinds vision, vision_failed and vision_timeout map to ok, failed and timeout`; `an unknown kind on a vision_return node reports outcome unknown and still builds a row`; `the request id is parsed from vision-<id>-out and vision-<id>-back, with or without the handoff: prefix`; `a non-vision handoff row has no vision key`.
- [ ] **Step 2: Run to verify failure** (`KeyError: 'vision'`).
- [ ] **Step 3: Implement** `_vision` with a regex on the id tail and the kind-to-outcome table; add the two `CAUSE_TEXT` strings ("Vision delegation: the session sent an image to a vision model", "Vision result: the vision model handed its findings back"); document both causes, the id pattern and the kind values in `lineage-events.md`.
- [ ] **Step 4: Run to verify pass**, including the existing tests in that file.
- [ ] **Step 5: Commit** `feat(lineage): vision delegation causes and summary`.

### Task 2: Dashboard card — wording and outcome badge

**Files:**
- Modify: `packages/handoffs-view.js` (`CAUSE` at line 53, `handoffCard`, `detailHtml`)
- Test: `packages/handoffs-view.test.js`

**Interfaces:**
- Consumes: the row's `vision` object (Task 1).
- Produces: `CAUSE` entries `vision_delegate: 'vision delegation'`, `vision_return: 'vision result'`; `outcomeText(vision: { outcome: string } | undefined): string` returning `'analysis complete'`, `'partial analysis'`, `'analysis failed'`, `'timed out'` or `'outcome unknown'`.

- [ ] **Step 1: Write failing tests**: `a vision card names the cause, both models and the outcome`; `a partial outcome reads as partial analysis and is marked for attention`; `an unknown outcome reads as outcome unknown`; `hostile markup in a model name and in the request id is escaped in the card and the detail`; `non-vision cards render exactly as before`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** in the existing rendering style of `handoffCard` and `detailHtml`; reuse `esc` and `modelText`.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** `feat(dashboard): vision delegation cards`.

### Task 3: Round trips, cause filter and counts

**Files:**
- Modify: `packages/handoffs-view.js` (add exports; wire into `mountHandoffs`, read it first and follow its rendering and event pattern)
- Test: `packages/handoffs-view.test.js`

**Interfaces:**
- Consumes: rows with `vision`, `created_at`, `updated_at` (Task 1).
- Produces:
  - `visionRoundTrips(rows: Row[]): Array<{ requestId: string; out?: Row; back?: Row; outcome: string; durationMs: number | null; open: boolean }>` (pairs by `vision.request_id`; `open` when there is no back row; `durationMs` is back `updated_at` minus out `created_at`, null when either is missing)
  - `filterByCause(rows: Row[], cause: string | null): Row[]` (`null` returns all)
  - `visionStats(rows: Row[], now: number): { total: number; byOutcome: Record<string, number>; last24h: number; last7d: number }`

- [ ] **Step 1: Write failing tests**: `an out and a back row with one request id pair into one round trip with a duration`; `an out row with no back row is an open round trip`; `a back row without its out row stands alone with no duration`; `two delegations in the same second are two round trips`; `filterByCause returns only matching rows and null returns all`; `visionStats counts total, by outcome, the last 24 hours and the last 7 days from a fixed now`; `visionStats ignores non-vision rows and rows without a usable time`; `hostile request ids are escaped where round trips are rendered`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the three functions as pure functions, then add to `mountHandoffs` a cause filter control and a stats line ("N vision delegations: X last 24h, Y last 7d") above the list, and render each round trip as one linked entry opening the out and back details.
- [ ] **Step 4: Run to verify pass**, plus the whole `packages/handoffs-view.test.js`.
- [ ] **Step 5: Commit** `feat(dashboard): vision round trips, cause filter and counts`.

### Task 4: End-to-end check against real Pi events

**Files:**
- Create: `docs/evidence/vision-delegation-dashboard.md`

**Interfaces:**
- Consumes: the Pi plan's acceptance spike (Task 10), which emits real events.

- [ ] **Step 1:** After the Pi spike has run against a control plane, fetch the handoff rows through the same API the Handoffs page uses and confirm two vision rows per delegation with the right causes and models.
- [ ] **Step 2:** Open the Handoffs page, confirm the round trip, outcome, duration and the stats line, and take a screenshot.
- [ ] **Step 3:** Record the API output and screenshot path in `docs/evidence/vision-delegation-dashboard.md`.
- [ ] **Step 4: Commit** `docs: vision delegation dashboard evidence`.
