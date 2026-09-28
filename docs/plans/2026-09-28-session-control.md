# Session control implementation plan

**Goal:** Query and notify a specific live PI Engineering session from another local session without confusing process liveness with mission progress.

**Architecture:** Each session owns a Unix socket and atomic descriptor under a private per-user runtime directory. The extension publishes process and tool activity; the server reads the existing mission snapshot on demand. A CLI discovers and queries instances with bounded concurrency.

**Tech stack:** Node built-ins (`net`, `fs`, `crypto`), existing extension hooks, Node test runner; no new dependencies.

**Spec:** `docs/specs/session-control.md`.

## Tasks

1. Test and implement the socket protocol: private directory, per-instance descriptor, nonce ping, bounded status, note, timeout, exact targeting and lifecycle cleanup. Exercise concurrent servers and stale descriptors.
2. Test and implement the CLI: list/ping/status/note/watch, JSON output, bounded parallel discovery, meaningful exit codes. Keep repo snapshots read-only.
3. Wire extension `session_start`, `session_shutdown`, and tool lifecycle updates. Verify session switching closes the previous instance, messages remain UI-only, and headless sessions degrade safely.
4. Run targeted tests, typecheck, formatting, broader tests and independent diff review. Update operator docs, commit on the isolated feature branch, push, open a PR and merge only after the required checks pass.
