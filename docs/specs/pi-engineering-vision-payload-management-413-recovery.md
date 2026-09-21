# Pi-Engineering Vision Payload Management and 413 Recovery

## 1. Purpose

Pi-Engineering must support long-running engineering sessions that use large implementation specifications, screenshots, generated UI mockups, design-reference images, responsive layouts, visual regression screenshots, source code, documentation, and multiple vision-analysis passes. The current behavior can cause HTTP 413 Request Entity Too Large failures when image data accumulates in the model conversation.

This specification introduces a first-class Vision Asset Pipeline, Request Budget Manager, Vision Analysis Worker, and 413 Recovery System, making image-heavy engineering workflows safe, automatic, deterministic, and scalable.

## 2. Problem

A typical UI implementation session accumulates large specifications, source files, and multiple reference images with their analyses, producing a very large serialized model request. Images may be represented by encoded binary data inside the request, which can exceed Pi Web upload/body limits, reverse-proxy body limits, InferWeave gateway request limits, model-server request limits, provider API limits, and intermediate proxy limits. This may occur before the model context-token limit is reached, so token-based context management alone is insufficient. Pi-Engineering must manage context tokens, serialized HTTP request bytes, image pixel dimensions, encoded image size, number of active visual assets, and model/provider request limits.

## 3. Design Principle

Images are temporary analysis inputs, not permanent conversational context. The normal lifecycle is: Original image -> Vision Asset Processor (metadata, thumbnail, vision-sized derivative, optional tiles) -> Isolated Vision Analysis Worker -> Structured DesignObservation -> Persistent textual design contract -> Main Engineering Agent. The main engineering agent should normally receive DesignObservation text rather than original image binary.

## 4. Scope

This system applies automatically to UI reference images, screenshots, mockups, Figma exports, generated design references, responsive-layout references, browser screenshots, visual test screenshots, diagrams requiring visual interpretation, and images embedded in engineering specifications. It also applies to AIMS Console, InferWeave, Pi-Engineering, and future projects. No manual /vision-optimize command should be required.

## 5. Core Components

Implement: VisionAssetManager, VisionAssetProcessor, VisionAnalysisWorker, VisionObservationStore, RequestBudgetManager, ContextAssetManager, VisualVerificationWorker, PayloadRecoveryManager, and ProviderLimitRegistry. These may initially exist within the Pi-Engineering orchestration service but must expose clean internal interfaces.

## 6. Vision Asset Manager

The VisionAssetManager owns the lifecycle of every image supplied to an engineering session. Each asset gets an immutable ID, e.g. { assetId, sourcePath, sha256, mimeType, width, height, originalBytes, createdAt, status }. The original asset remains unchanged. Generated derivatives live separately in a content-addressed cache (by SHA-256), e.g. under a .vision-cache/ directory keyed by sha256 with source-metadata.json, vision-1600.jpg, thumbnail-400.jpg, analysis.json, and analysis.md.

## 7. Automatic Image Normalization

Before any image is sent to a model, inspect file size, pixel dimensions, format, alpha channel, orientation, and animation/frame count. Generate an optimized vision derivative whenever appropriate. Default maximum long edge 1800 px, configurable 1200-2400 px. Default output JPEG quality 82. Use PNG only where JPEG would destroy relevant information (very small UI typography, transparency-sensitive images, pixel-perfect diagrams). Strip unnecessary metadata. Preserve aspect ratio. Do not upscale images.

## 8. Image Tiling

Large screenshots may contain UI text that becomes unreadable after downscaling, so support optional automatic tiling: overview.jpg plus tile-01.jpg etc. Use tiling if width > 3000 or height > 3000 or detected UI text would become unreadable at target resolution. The vision worker should first analyze the overview, then inspect only relevant tiles. Never blindly send every tile to the main engineering session.

## 9. Isolated Vision Analysis Worker

Visual-reference interpretation must run in an isolated model interaction. The worker receives the current design-analysis schema, one visual asset, and limited project/design context. It returns structured text. The raw image does not become part of the main agent's long-lived conversation. The analysis task extracts layout hierarchy, component hierarchy, visual grouping, navigation, spacing, typography, cards and panels, graphs, interaction patterns, responsive behavior, desktop/tablet/mobile differences, reusable components, implementation constraints, notable visual details, and accessibility concerns, returning structured JSON plus human-readable Markdown.

## 10. DesignObservation Schema

Each analyzed image produces a structured artifact with assetId, reference, summary, layouts, components, navigation, responsiveBehavior (desktop/tablet/mobile), visualHierarchy, interactionPatterns, reusablePatterns, implementationConstraints, accessibilityNotes, unknowns, and confidence. The schema must be versioned as DesignObservation/v1.

## 11. Human-Readable Analysis Artifact

Alongside JSON, generate a <reference>.analysis.md file giving developers and future agents a durable explanation of each visual reference.

## 12. Unified Design Contract

After visual references are analyzed, generate or update a UNIFIED-DESIGN-CONTRACT.md. The contract becomes the primary source of truth during implementation and should contain: design philosophy, application shell, page hierarchy, reusable components, information hierarchy, visual tokens, typography, spacing, panel behavior, navigation behavior, responsive rules, desktop rules, tablet rules, mobile rules, data visualization conventions, animation rules, interaction rules, accessibility requirements, implementation constraints, and reference-to-feature traceability. Once generated, normal engineering turns should use this contract rather than repeatedly reopening the images.

## 13. Reference Traceability

Every extracted requirement must retain provenance, e.g. a requirement with sources listing reference and region. This enables future verification against the original design source without carrying the image continuously.

## 14. Main Engineering Agent Rules

Rule 1: Never automatically reopen a reference image that already has a valid DesignObservation. Rule 2: Prefer analysis.md and UNIFIED-DESIGN-CONTRACT.md over raw visual assets. Rule 3: Open the original visual reference only when an ambiguity exists, implementation differs from reference, visual verification is required, analysis confidence is low, or the user specifically requests visual reinspection. Rule 4: When reinspection is required, use an isolated vision worker. Rule 5: Do not retain the resulting image payload in the main agent context.

## 15. Request Budget Manager

Pi-Engineering must track two independent budgets: TokenBudget and PayloadByteBudget. Existing context-window management is insufficient. Before every model call estimate text bytes, JSON serialization overhead, tool-call state, image encoded bytes, message metadata, and provider wrapper overhead. Expose estimatedPayloadBytes, estimatedTokens, activeImageCount, and encodedImageBytes.

## 16. Budget Thresholds

Use configurable thresholds with recommended defaults: SAFE < 50%, WARNING 50-65%, MITIGATE 65-80%, CRITICAL > 80%. At WARNING log a warning and stop adding unnecessary image context. At MITIGATE offload old images, replace old visual payloads with DesignObservations, and compact context if useful. At CRITICAL do not issue the request as currently constructed; perform context/payload reduction first.

## 17. Provider Limit Registry

Different inference endpoints may have different constraints. Create a ProviderLimitRegistry with per-provider limits such as maxRequestBytes, maxContextTokens. Infer capabilities dynamically wherever possible. Do not hardcode limits into agent prompts.

## 18. Request Preflight

Before every model request, run RequestBudgetManager.preflight(request) which returns whether the request is allowed, estimatedBytes, maximumBytes, reductionRequired, and recommendedActions. The orchestrator should automatically perform mitigation.

## 19. Payload Reduction Order

When a request is too large, reduce in this order: 1) Remove previously analyzed raw images. 2) Replace them with DesignObservations. 3) Remove duplicate image representations. 4) Use resized derivatives. 5) Remove unnecessary tool outputs. 6) Summarize stale verbose outputs. 7) Compact conversational history. 8) Split work into isolated workers. Do not begin by deleting critical engineering requirements.

## 20. Automatic 413 Recovery

HTTP 413 must be treated as a recoverable orchestration event. Current behavior stops the task; required behavior captures a diagnostic, classifies the likely boundary, removes raw image payloads, normalizes outstanding images, compacts if appropriate, retries once, and continues the task. Do not retry the exact same payload.

## 21. 413 Diagnostic Event

Record a diagnostic with type MODEL_REQUEST_TOO_LARGE, httpStatus 413, requestBytesEstimated, activeImages, encodedImageBytes, tokenEstimate, provider, endpoint, recoveryAction, and retrySucceeded. Never store secrets or authorization headers.

## 22. Boundary Detection

A 413 may originate from the browser to Pi-Web, Pi-Web to daemon, reverse proxy, Pi to InferWeave, InferWeave to model runtime, or the provider API. The diagnostic layer should distinguish these where possible and record response headers and endpoint classification where safe.

## 23. Context Compaction Improvements

Compaction must consider both token pressure and payload pressure. Introduce reasons: TOKEN_PRESSURE, BYTE_PRESSURE, IMAGE_PRESSURE, TOOL_OUTPUT_PRESSURE. A byte-pressure compaction should strongly prioritize removing binary/visual payloads.

## 24. Image Lifetime

Every visual payload should have a context lifetime: NEW -> ACTIVE_ANALYSIS -> OBSERVATION_EXTRACTED -> OFFLOADED. After OBSERVATION_EXTRACTED, raw image content should normally disappear from subsequent requests. The persistent asset remains available on disk.

## 25. Visual Verification Workflow

Implementation still requires images, but visual verification should also be isolated. Workflow: implemented UI -> Playwright screenshot -> normalized screenshot + reference derivative -> VisualVerificationWorker -> VisualDiffObservation -> engineering agent. The engineering agent receives text describing differences (e.g. header height, badge colors, tablet column count, mobile drawer behavior), not multiple full-resolution screenshots indefinitely.

## 26. VisualDiffObservation

Create a structured schema with route, viewport (width/height), differences (component, severity, difference, recommendation), and overallConfidence.

## 27. Responsive Verification

Automatically test viewports 390x844, 768x1024, 1024x768, 1440x900, 1920x1080 plus any project-defined breakpoints. Do not create separate implementation branches for each screen. Responsive behavior must derive from reusable components and layout primitives.

## 28. Pi-Web Configuration

Expose PI_WEB_MAX_UPLOAD_BYTES with a documented production default (recommended 134217728, or 128 MiB). This is a safety margin only; increasing HTTP limits must not replace the vision-context architecture.

## 29. Reverse Proxy Limits

Deployment validation should inspect relevant proxies (nginx, Traefik, Caddy, Cloudflare, custom gateways). Pi-Engineering health diagnostics should report mismatched body limits.

## 30. InferWeave Integration

InferWeave should advertise capabilities such as maxRequestBytes, maxContextTokens, supportsVision, preferredImageLongEdge, and maxImagesPerRequest. Pi-Engineering should consume these dynamically, preferable to embedding provider-specific assumptions.

## 31. Model Routing

Image analysis should use vision-capable models. The main implementation agent does not necessarily need every image. Workflow: InferWeave task analyze-ui-reference routes to a vision-capable model, implement-react-component routes to a stronger coding model, and visual-regression-review routes back to a visual model.

## 32. Worker Isolation

Every vision worker should start with minimal context, passing only the relevant image, visual-analysis instructions, relevant design-contract fragment, and small project context. Avoid sending the full engineering conversation, full source tree, all prior screenshots, and all previous reference images.

## 33. Concurrency

Multiple independent reference images may be analyzed concurrently if resource limits permit. Results then merge into the unified design contract. Respect InferWeave admission and caller-concurrency policies. Do not trigger uncontrolled parallelism.

## 34. Merge Worker

Create a DesignContractMerger whose input is DesignObservation[] and output is UNIFIED-DESIGN-CONTRACT.md. The merger must combine consistent patterns, identify conflicts, preserve provenance, flag ambiguity, and avoid silently overriding references. Conflicts require resolution unless reference precedence is explicitly defined.

## 35. Reference Precedence

Support explicit precedence, e.g. references with roles visual-language, feature-detail, and responsive-authority. A responsive-authority reference governs responsive behavior where conflicts occur.

## 36. Developer Visibility

Pi-Web should display visual-processing state: each design reference with analyzed/analyzing status, derivative size, and requirements count. After completion, raw image is removed from active context.

## 37. Request Diagnostics UI

Expose a development/debug panel showing current model request tokens, serialized payload size, active image count, image payload size, tool-output payload size, and status (SAFE/WARNING/MITIGATE/CRITICAL).

## 38. Automatic Protection

Before adding an image to a model request: if originalBytes > configuredThreshold, normalize; if requestBudget.wouldExceedLimit(derivative), use isolatedVisionWorker; if alreadyAnalyzed, use observation instead.

## 39. Duplicate Detection

Images should be hashed. If the same image (same SHA-256) is requested again, reuse the existing derivative and analysis unless explicitly asked to reanalyze. This prevents repeated vision cost and payload growth.

## 40. Cache Invalidation

Reanalyze when the source SHA changes, the analysis schema version changes, the user explicitly requests reanalysis, or model/policy requires migration. Otherwise reuse cached results.

## 41. Repository Structure

docs/specs/aims-console/design/references/ holds original references; docs/specs/aims-console/design/analysis/ holds per-reference .analysis.json and .analysis.md; a UNIFIED-DESIGN-CONTRACT.md sits alongside. Temporary derivatives normally live outside version control under .vision-cache/.

## 42. Git Behavior

Commit original references, analysis artifacts, and the design contract. Normally do not commit temporary JPEG derivatives, temporary tiles, or binary request caches unless explicitly desired.

## 43. Security

Visual assets may contain confidential information. Keep the cache local by default, do not expose images through public URLs, do not upload images to external services unless provider policy permits, preserve existing project/provider restrictions, and clean temporary files according to retention settings.

## 44. Logging

Log asset ID, asset size, derivative size, dimensions, model selected, analysis duration, estimated request size, and recovery actions. Do not log image binary data.

## 45. Metrics

Export metrics for Grafana/OpenTelemetry: pi_vision_assets_total, pi_vision_asset_original_bytes, pi_vision_asset_derivative_bytes, pi_vision_analysis_requests_total, pi_vision_cache_hits_total, pi_request_estimated_bytes, pi_request_payload_utilization, pi_http_413_total, pi_http_413_recovered_total, pi_context_compactions_total, pi_context_compaction_byte_pressure_total.

## 46. Alerts

Warn if 413 rate exceeds threshold, payload exceeds 80% repeatedly, normalization ratio is ineffective, the same visual asset is repeatedly reanalyzed, or provider limits cannot be determined.

## 47. Unit Tests

Test image metadata extraction, derivative sizing, hashing, caching, request-byte estimation, budget transitions, duplicate detection, DesignObservation validation, and provider limit selection.

## 48. Integration Tests

Test a workflow with a large spec plus four 8K PNG references, expecting no 413 and the main agent containing textual observations rather than four encoded original images.

## 49. Recovery Test

Simulate provider max request 10 MB with request 12 MB. Expected: preflight catches the request, raw visual payload is replaced, request drops below threshold, model call succeeds.

## 50. Actual 413 Test

Mock endpoint returns HTTP 413. Expected: diagnostic generated, payload mitigation occurs, request rebuilt, one retry occurs, success continues the workflow, and it never retries endlessly.

## 51. Visual Regression Test

Given a reference image plus browser screenshot, verify comparison occurs in an isolated worker, the main agent receives textual differences, and the raw screenshot does not persist indefinitely.

## 52. Cache Test

Analyze an image, then analyze the same image again. Expected: cache hit, no new vision inference required.

## 53. Acceptance Criteria

AC-01: Process at least four large UI references in a long-running workflow without a 413 caused by accumulated raw image context. AC-02: Reference images analyzed in isolated vision workers. AC-03: Structured observations persisted. AC-04: A unified textual design contract generated. AC-05: Previously analyzed images not repeatedly injected into main context. AC-06: Request byte size estimated before model calls. AC-07: Byte-pressure and token-pressure tracked independently. AC-08: A predicted oversized request is reduced before transmission. AC-09: HTTP 413 triggers automatic recovery and one safe retry. AC-10: Visual verification uses isolated workers. AC-11: Responsive screenshots can be compared without poisoning long-lived context with image data. AC-12: Grafana/OpenTelemetry can expose payload and recovery metrics. AC-13: Provider/body limits are configurable and preferably discoverable. AC-14: No existing text-only engineering workflow regresses.

## 54. Implementation Phases

Phase 1 Immediate Protection: image normalization, image hashing, DesignObservation artifacts, do-not-reopen analyzed images. Phase 2 Payload Budgeting: RequestBudgetManager, byte estimation, warning thresholds, preflight mitigation. Phase 3 Vision Worker Isolation: VisionAnalysisWorker, DesignContractMerger, observation persistence. Phase 4 413 Recovery: PayloadRecoveryManager, boundary diagnostics, safe retry. Phase 5 Visual Verification: browser screenshot collection, VisualVerificationWorker, VisualDiffObservation, responsive verification. Phase 6 InferWeave Integration: task-level routing and dynamically advertised limits. Phase 7 Observability: metrics, Grafana dashboards, Pi-Web diagnostics, asset-analysis status UI.

## 55. Migration of Existing AIMS Console References

For the current AIMS Console references 01-04, perform migration immediately. Generate docs/specs/aims-console/design/analysis/ with structured analysis for every reference, using already-known findings for references 01-03 rather than unnecessarily reprocessing originals, and processing 04-responsive.png through the new normalized vision workflow. Then generate docs/specs/aims-console/design/UNIFIED-DESIGN-CONTRACT.md.

## 56. Important Non-Goal

The solution is NOT to increase every HTTP body limit indefinitely. Larger upload limits are useful as headroom but do not solve unbounded context growth. The architectural solution is: analyze visual asset, extract durable knowledge, remove binary payload from long-lived context.

## 57. Future Extensions

The same architecture should later support video frames, screen recordings, PDF page images, architecture diagrams, CAD/render references, game footage, and AIMS character video analysis. The abstraction could be called MediaObservationPipeline with VisionAssetPipeline as its first implementation.

## 58. Final Required Behavior

The user should be able to give Pi-Engineering a directory containing dozens of design references and simply say "Implement this design." Pi-Engineering should autonomously discover references, normalize them, analyze them safely, persist observations, merge the design contract, route implementation work, run the application, capture screenshots, compare implementation against references, generate corrective specifications, and iterate, without 413 failures, runaway context growth, repeated image ingestion, manual compaction, manual image resizing, or manual model routing. This behavior should become part of the default Pi-Engineering UI implementation workflow.
