# pi-engineering-runtime

A runtime / skill-pack that lets the **pi** coding agent drive engineering
workflows autonomously.

> **Status: scaffolded, spec landed, implementation pending.** No
> engineering workflow is implemented yet. The authoritative design spec is
> [docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md](docs/specs/pi-engineering-runtime-ledger-tournament-spec-v2.md).
> See [AGENTS.md](AGENTS.md) for operating policy.

## What it is

`pi-engineering-runtime` provides an autonomous engineering runtime for the
pi coding agent — spec → plan → implement → test → review — with a durable
Engineering Ledger, fresh-context workers, isolated candidates, deterministic
verification, and risk-adaptive orchestration. The design is defined in
docs/specs.

## Install as a pi extension

From anywhere:

```bash
pi install git:github.com/berlinguyinca/pi-engineering-runtime
```

For active development against a local clone:

```bash
pi install /absolute/path/to/pi-engineering-runtime
```

## Structure

```
AGENTS.md       autonomous operating policy for agents working here
extensions/     pi extension entry point(s)
skills/         (future) pi skills exposed by the runtime
docs/specs/     design specs
```

## License

MIT
