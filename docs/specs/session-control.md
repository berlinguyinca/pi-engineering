# Local session control

PI Engineering must let another local session distinguish a live mission from a stale status file and request a concise status without starting a second PI process against the same session log. This is a same-user, same-host control surface; it does not turn repo content into an instruction channel.

## Contract

- Every active PI session has a distinct process-instance ID, even when another process resumes the same PI session ID. Each instance owns one Unix-domain socket and one descriptor in a mode-0700 per-user runtime directory. Descriptors contain only routing metadata and a last process heartbeat; each is replaced atomically. No central mutable registry file exists.
- A fresh `ping` reply proves that the target process event loop answered a nonce without consulting repository storage. `status` returns bounded session activity plus a compact, read-only view of the repository mission snapshot. Process liveness, tool progress and mission progress are separate fields. A stale mission heartbeat is not described as a dead process.
- A session attributes mission IDs from its own orchestration progress callbacks. Its status prefers that process's in-memory mission store and filters any fallback repository snapshot to those IDs, so dozens of sessions in one checkout do not each claim the other sessions' missions or depend on the last snapshot writer. Before an ID is observed, mission attribution is unknown rather than guessed from the newest snapshot row.
- `note` delivers at most 1 KiB of text as an informational UI notification to the selected live instance. It is never inserted into the model context, never executes a command, and does not steer an in-flight mission. An explicit future steering protocol may add that behavior with its own authorization and acknowledgement rules.
- The CLI lists dozens of sessions with bounded parallelism and timeouts, addresses an exact instance ID, and reports unreachable or stale descriptors rather than silently choosing another process. Session shutdown removes only its own socket and descriptor. A crash leaves a descriptor that queries report as unreachable.
- The protocol is newline-delimited JSON, versioned, bounded in bytes and time, and local-only. The server rejects unknown operations, oversized requests and non-string notes. No prompt, transcript, API key, or raw tool payload appears in status output.

## Operator surface

`pi-engineering sessions list [--json]`, `pi-engineering sessions ping <instance-id>`, `pi-engineering sessions status <instance-id>`, and `pi-engineering sessions note <instance-id> <text>` work independently of the interactive PI terminal. `sessions watch` polls status and prints changes without starting another agent or writing the target session file.

This does not retrofit already-running PI processes; they acquire the control socket when started with the new extension version.
