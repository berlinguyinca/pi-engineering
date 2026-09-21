# 03 — Integrate External Plannotator
Plannotator is an EXISTING EXTERNAL/UPSTREAM TOOL. **Do not implement a replacement Plannotator UI/service.**

Inspect its actual CLI/API/server/container interfaces. Implement pi-engineering-side plan handoff, decision ingestion, persisted correlation and policy:
- interactive: invoke/use external Plannotator and wait for approve/annotate/reject;
- autonomous: bypass Plannotator explicitly and audit the policy decision;
- policy: invoke it only for configured risk classes;
- disabled: no invocation.

Provide deployment/config references only where needed to run the external tool. Recovery belongs to pi-engineering only for its own pending run/plan correlation state.
