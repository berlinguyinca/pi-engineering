# 08 — Existing PI WEB Integration

## External dependency

PI WEB means the existing external repository:

`https://github.com/jmfederico/pi-web`

Do not rebuild it.
Do not create a replacement UI.
Do not fold Pi Engineering into a proprietary fork unless upstream/plugin limitations make a very small patch unavoidable.

## Integration role

PI WEB is the operator/observation surface.

Pi Engineering remains the orchestration authority.

## Desired hierarchy

```text
PI WEB parent session
  |
  +-- Mission
       |
       +-- Task
            |
            +-- Pi child/tracked session
            +-- subprocess
            +-- worktree
            +-- artifacts
```

Where PI WEB already provides persistent/tracked sessions, reuse them as the visible child-session hierarchy.

## UI capabilities to add through supported extension mechanisms

Mission panel:

- mission title/status
- progress
- current phase
- acceptance criteria
- blocking issues

Task tree:

- pending/running/done/failed
- role
- model
- duration
- worktree
- dependency state

Execution details:

- child session link
- process status
- stdout/stderr tail
- files changed
- token/usage information where available

Review:

- findings
- severity
- status
- repair mapping

Controls:

- cancel mission
- cancel task
- reprioritize
- retry
- steer child
- open worktree/session
- approve required human gate

## API boundary

Prefer:

- plugin APIs
- backend provider APIs
- tracked session APIs
- event/subscription integration

Avoid modifying PI WEB core for orchestration logic.

If a core patch is required:

- keep it minimal,
- isolate it,
- document upstream divergence,
- prefer a contribution that could be upstreamed.

## No duplication

Do not create:

- another session browser
- another terminal UI
- another repository viewer
- another worktree manager
- another chat frontend

Use PI WEB's existing capabilities.
