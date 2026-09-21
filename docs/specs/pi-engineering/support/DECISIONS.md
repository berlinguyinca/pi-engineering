# Current Architecture Decisions
- Pi is the engineering runtime.
- pi-subagents upstream-first.
- Pi Web is the single operator UI.
- Pi Forge is out of scope and must not be used.
- Plannotator is a Dockerized plan gate; autonomous mode may explicitly bypass it.
- OpenViking is mandatory shared durable memory.
- Blackhole remains local to each Pi session.
- Runtime correctness/history is EventStore/PostgreSQL.
- AutoSpec consumes Pi; it does not supervise Pi processes.
- InferWeave is external and owns inference scheduling/GPU placement.
- Context capability is discovered dynamically; no fixed 260k reservation architecture.
- InferWeave capacity uses dynamic seats, not fixed equal-cost slots.
- Parallel mutating agents use isolated worktrees.
- Observability never requires hidden chain-of-thought.
- Target 30–40 simultaneous agents; validate 50.
- Surrounding services are Docker-first.

- Pi Web and Plannotator are external/upstream tools: integrate them; do not implement them in pi-engineering.
- Pi, pi-subagents, Blackhole and AutoSpec are external/sibling codebases: local work is adapters/policy unless explicitly modifying those repositories upstream.

- Pi Forge is explicitly OUT OF SCOPE. Do not evaluate or integrate it. Pi Web is the selected external operator UI.
