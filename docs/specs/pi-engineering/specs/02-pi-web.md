# 02 — Integrate External Pi Web
Pi Web is an EXISTING EXTERNAL/UPSTREAM TOOL. **Do not build Pi Web in this repository.**

Inspect its current supported APIs/extensions/configuration. Implement only the pi-engineering-side adapter/configuration needed to expose projects, runs, workers, events, tests, diffs, reviews, routing/memory status and interventions through Pi Web. Prefer Pi Web's native capabilities and extension points. If a desired UI feature is absent upstream, document the gap and determine whether it belongs as an upstream Pi Web contribution; do not silently create a replacement frontend/backend here.

Acceptance: pi-engineering can use the existing Pi Web installation as its operator surface without owning Pi Web source.
