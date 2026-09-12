# pi-engineering-runtime

A runtime / skill-pack that lets the **pi** coding agent drive engineering
workflows autonomously.

> **Status: scaffolded, spec pending.** This repo is a placeholder package
> structure awaiting a large design spec. No engineering workflow is
> implemented yet — see [docs/specs/](docs/specs/).

## What it is

`pi-engineering-runtime` will provide an autonomous engineering loop for the
pi coding agent — moving from spec → plan → implement → test → review, with
long-running state, orchestration, and resumability. The exact design is
defined by an upcoming spec.

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
extensions/     pi extension entry point(s)
skills/         (future) pi skills exposed by the runtime
docs/specs/     design specs (pending)
```

## License

MIT
