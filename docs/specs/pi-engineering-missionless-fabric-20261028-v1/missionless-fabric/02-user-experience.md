# 02 — User experience: terminal, web and phone

## Golden rule
Ordinary prompts are answered by the foreground agent; background work never monopolizes conversation or steals editor focus. No forced `/mission` command. A short request does not require a plan or team.

## Execution preference
- `direct`: foreground Pi, explicit delegation, mandatory policy checks still in force.
- `adaptive` (default): foreground Pi decides to delegate only when estimated quality/latency benefit is substantial; no gratuitous workers.
- `team`: explicit multi-agent coordination, automatic bounded parallel tasks when beneficial.
- Settings are persisted per user/project and may be changed mid-task without losing the current state. Every mode can switch models through routing policy/operator pin and support recovery.

## Terminal minimal surface
Default: one status row `project | task | active model | branch/worktree | workers N | activity age | blockers N | tokens/s`. Only show task-specific data when task is associated; do not introduce a permanent mission bar. Compact 1-2 line optional panel showing agents with one-line current action and attention. Keep standard editor/commands and streaming response available; `Esc` interrupt semantics must be unambiguous and tested. `/summary` yields local session evolution, tasks started/finished/unresolved, artifacts, decisions, handoffs, next actions. Optional `/task`, `/team`, `/handoff`, `/plan`; audit existing commands before adding aliases. Natural-language equivalents work without special commands.

## Web dashboard / room
Default project screen: simple task list, active agent cards, attention queue, links to current PR/tests/artifacts. Selecting a task opens persistent lineage graph with session nodes, handoff edges, branch/PR/CI/artifact nodes, inspectable history and time-based playback. A room can attach to an existing session or task and steer with authority checks; no duplicated conversation database. Graph is persistent and survives restart/reconnect. Multi-user live changes use revisioned event stream. Status data shows observed activity, not fabricated percentages; percentage only where measurable work units exist. Read-only artifact viewer; artifact authoring from CLI/Pi commands only.

## Approval and communication
Planning words (`plan`, `/plan`, 'let's plan') enter planning behavior, but neither Plannotator nor autonomous work is automatically required. Generate plan inline; optionally suggest opening in local Herdr Plannotator after the plan. User can accept, edit, discard, delegate or execute directly. Avoid modal interruption except for real authority-sensitive approval. The personal assistant may request tasks, summarize progress, and draft outbound messages; sending emails requires permission under the user's policy.

## Example interactions / acceptance
- `Fix broken navigation` → direct Pi starts investigation, may edit, test and report, no Mission creation.
- `Delegate tests to Qwen and have Claude review` → launches designated roles, produces visible handoffs and evidence, foreground remains interactive.
- `Plan a rewrite` → generates plan, optional Plannotator suggestion, no compulsory execution.
- `Continue where we left off` → recover last checkpoint + actual Git status, show pending scope before mutation.
- `What's happening?` → concise real activity, last meaningful progress, current blocker, next action and links.
- `Stop only the reviewer` → scoped cancellation; other runs continue safely.
- `Open this on phone` → same task/graph/projections, no phone-only state.
