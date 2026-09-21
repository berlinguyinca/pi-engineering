# 01 — Intent and Policy Router

## Goal

Select workflows automatically from user intent and runtime facts.

## Requirements

Implement a router with two stages:

### Stage A — Semantic intent

Classify user requests into one or more intents:

- explain
- research
- investigate
- implement
- modify
- refactor
- fix
- review
- validate
- release
- security-review
- migrate

Return:

```json
{
  "intent": ["implement"],
  "confidence": 0.96,
  "suggested_workflow": "engineering_review",
  "risk_hints": ["auth"],
  "needs_scout": true
}
```

### Stage B — Deterministic policy enrichment

Observe facts such as:

- files written,
- file classes changed,
- manifests/lockfiles changed,
- tests changed,
- migrations changed,
- auth/security-sensitive paths changed,
- generated files changed,
- process outcomes,
- review findings.

These facts may upgrade workflow requirements even if semantic classification did not.

## Required behavior examples

```text
"Explain this function"
 -> conversation

"Find where auth happens"
 -> research

"Why is login failing?"
 -> investigation

"Fix login"
 -> engineering_review

"Implement OAuth"
 -> engineering_review + security review

"Review my changes"
 -> review

"Is this ready?"
 -> review + validation
```

## Non-negotiable rule

No mandatory workflow may depend on the user typing a slash command.

Slash commands may override, debug, or inspect routing, but cannot be the only path into the workflow.

## Extensibility

Policies should be declarative where possible:

```yaml
policies:
  source_mutation:
    when:
      event: repository.material_change
    require:
      - validation
      - independent_review

  auth_mutation:
    when:
      path_matches:
        - "**/auth/**"
        - "**/security/**"
    require:
      - correctness_review
      - security_review
```

Avoid hard-coding every repository-specific convention in application code.
