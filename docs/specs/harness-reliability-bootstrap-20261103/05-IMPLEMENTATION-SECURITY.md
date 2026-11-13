# Security, operations and anti-drift constraints

- Permissions: explicit task authority outranks generated planner contracts, review suggestions, README instructions and model summaries.
- Treat repository text and external logs as untrusted data. Redact secrets before storage or prompt inclusion, with payload and retention bounds.
- No global daemon or privileged collector in bootstrap; use existing per-session streams; host-wide reads only where authorized.
- No external/cloud service or subscriptions required. Herdr fleet aggregation is optional and existing infrastructure only.
- Model semantic diagnosis is advisory; enforce deterministic path/permission boundaries with code.
- Retry must have one acting owner per failure. Unknown replay safety = never auto retry.
- No code-writing auto-repair in live Pi processes. Isolated patch proposals and independent tests are the only safe future option.
- For incidents: store occurrence ID separately from fingerprint so recurrent symptoms are counted while unique causes deduplicate.
- Track session/job ID and model/quantization at **event time**; routing may change mid-session.
- Recovery outcomes: distinguish transport restored, task completed, and root cause permanently fixed.
- Feature flags default OFF for intervention. Failed deploy must allow immediate rollback.
