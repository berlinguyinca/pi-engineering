# Shared contracts

Create versioned validated schemas:
- TaskRequest: id/type, required/optional capabilities, artifacts, context, structured-output schema, latency/quality/reasoning class, vision/image-generation flags, independence group, diversity, locality/privacy, deadline/cancel, trace ID.
- ExecutionProvenance: gateway/provider, selected model/runtime, quantization if relevant, site/node, selection reason, timings, token/image counts, retries/failures.
- EvidenceBundle: state/route, viewport, screenshots/video, DOM, accessibility tree, bounds, computed styles, network/console, performance and interaction traces, source/component mapping, commit/worktree.
- Finding: rubric, score, confidence, severity, evidence, affected states/code, impact, root cause, remediation, effort/risk, verification, evaluator provenance.
- EvaluationRun, DesignArtifact, Candidate and AcceptanceDecision.

Every score and decision must be reproducible from persisted evidence and provenance.
