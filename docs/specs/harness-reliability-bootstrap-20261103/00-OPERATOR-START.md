# Operator quick start

## Recommended local process
1. Download ZIP into Mac `~/Downloads`. If Pi runs on a remote host, copy the entire ZIP from the **Mac Downloads** directory to that host with scp/rsync before extracting. Never assume the remote host has the file.
2. On the machine where Pi executes: verify `git -C /path/to/pi-engineering status --short` and `git -C /path/to/herdr-engineering status --short`. Do not delete or overwrite changes.
3. Inspect package archive listing before extracting. Extract into each destination's uniquely named `docs/specs/harness-reliability-bootstrap-20261103/` or an operator-owned isolated workspace; do not clobber existing specs. Prefer a **single canonical source-of-truth package** referenced by both repos, rather than copying independently edited contracts.
4. Follow `06-ONE-SHOT-LOCAL-START-PROMPT.md` to perform B00 only, and hand the result to the operator for approval.
5. For subsequent tasks, run one agent at a time and supply exactly one task file plus signed/approved predecessor evidence.

## Basic repository commands (read-only)
```bash
git -C /path/to/pi-engineering status --short
git -C /path/to/pi-engineering rev-parse HEAD
git -C /path/to/herdr-engineering status --short
git -C /path/to/herdr-engineering rev-parse HEAD
```

## Not automatic
This ZIP is a specification and handoff framework, not an already installed slash-command skill, test runner or diagnosis service. Do not claim that `/diagnose-errors` exists until D06 is implemented and tested. Bootstrap executor is delivered incrementally in B01-B05.
