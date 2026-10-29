/**
 * MissionStore layer: Evidence invalidation, candidate evidence, GitHub linkage, DAG, leases.
 * Moved verbatim out of missionStore.ts; composed by inheritance (state lives in
 * MissionStoreBase, `private` members became `protected` so layers can share them).
 */

import { id } from "../core/ids.ts";
import {
  type GithubGateDecision,
  type GithubLinkPatch,
  type GithubLinkRecord,
  type GithubLinkSuggestion,
  type GithubRereviewRequest,
  type GithubStaleSignal,
  linkIdFor,
} from "../github/types.ts";
import {
  buildCandidateEvidenceIdentity,
  hashCandidateEvidenceIdentity,
  validateAcceptanceResults,
} from "./evidence.ts";
import {
  candidateKey,
  copyCandidateRevision,
  copyEvidenceInvalidation,
  copyReviewEvidence,
  copyValidationEvidence,
} from "./missionStoreCopy.ts";
import { MissionStoreRecords } from "./missionStoreRecords.ts";
import { type DagProjection, applyGithubLinkPatch } from "./missionStoreTypes.ts";
import type {
  CandidateEvidenceIdentity,
  CandidateRevision,
  EvidenceInvalidation,
  Execution,
  LeaseTransition,
  MissionLease,
  OrchestrationTask,
  ReconstructedCandidateSource,
  RepositoryLease,
  ReviewEvidence,
  ValidationEvidence,
} from "./types.ts";

export abstract class MissionStoreEvidence extends MissionStoreRecords {
  invalidateEvidence(invalidation: EvidenceInvalidation): EvidenceInvalidation {
    if (!this.missions.has(invalidation.missionId)) throw new Error(`unknown mission ${invalidation.missionId}`);
    const copy = copyEvidenceInvalidation(invalidation);
    this.evidenceInvalidations.set(copy.invalidationId, copy);
    this.emit("evidence.invalidated", invalidation.missionId, {
      actor: "system",
      invalidation: copy,
    });
    return copyEvidenceInvalidation(copy);
  }

  recordCandidate(
    missionId: string,
    rawIdentity: CandidateEvidenceIdentity,
    reason: string,
    provenance: { taskId: string; executionId: string },
  ): CandidateRevision {
    if (!this.missions.has(missionId)) throw new Error(`unknown mission ${missionId}`);
    const identity = this.assertCandidateIdentity(missionId, rawIdentity, hashCandidateEvidenceIdentity(rawIdentity));
    const identityHash = hashCandidateEvidenceIdentity(identity);
    this.assertCandidateProvenance(missionId, identity, provenance.taskId, provenance.executionId);
    this.assertUnusedCandidateExecution(provenance.executionId);
    const key = candidateKey(missionId, identity.repoId);
    const prior = this.candidates.get(key);
    if (prior && prior.identityHash !== identityHash) this.invalidateCandidate(prior, reason);
    // A same-content re-record (e.g. gate evidence re-published over the
    // reconstructed candidate) keeps the reconstruction origin: the marker
    // documents where the content CAME FROM, which later evidence does not
    // change. A different-content candidate starts a fresh origin.
    const carriedOrigin = prior && prior.identityHash === identityHash ? prior.reconstructedFrom : undefined;
    const candidate: CandidateRevision = {
      missionId,
      taskId: provenance.taskId,
      executionId: provenance.executionId,
      identity,
      identityHash,
      reason: reason.trim() || "candidate changed",
      recordedAt: new Date().toISOString(),
      ...(carriedOrigin ? { reconstructedFrom: carriedOrigin } : {}),
    };
    this.candidates.set(key, candidate);
    this.candidateExecutionIds.add(candidate.executionId);
    this.emit("candidate.changed", missionId, { actor: "system", candidate });
    return copyCandidateRevision(candidate);
  }

  /**
   * Record a candidate reconstructed (Git-verified) from preserved worker work
   * after the producing execution failed before publishing (#360). Unlike
   * {@link recordCandidate} this does NOT require a SUCCEEDED authoritative
   * execution for provenance — the trust anchor is instead that the source
   * checkpoint's candidateSha is Git-verifiable and matches this identity.
   * The candidate is marked with `reconstructedFrom` so it stays auditable.
   *
   * NOTE(#360): the caller is responsible for ensuring the candidate target
   * worktree carries this candidate's content before the gate runs (validation
   * with candidateScoped backends throws CANDIDATE_UNAVAILABLE otherwise).
   */
  recordReconstructedCandidate(
    missionId: string,
    rawIdentity: CandidateEvidenceIdentity,
    source: { checkpointId: string; branch: string | null },
    reason?: string,
  ): CandidateRevision {
    if (!this.missions.has(missionId)) throw new Error(`unknown mission ${missionId}`);
    const identity = this.assertCandidateIdentity(missionId, rawIdentity, hashCandidateEvidenceIdentity(rawIdentity));
    const identityHash = hashCandidateEvidenceIdentity(identity);
    const checkpoint = this.taskCheckpoints.get(source.checkpointId);
    if (!checkpoint || checkpoint.missionId !== missionId)
      throw new Error(`reconstruction source checkpoint not found for ${missionId}`);
    if (checkpoint.candidateSha !== identity.candidateSha)
      throw new Error("reconstruction source checkpoint sha does not match the candidate identity");
    if (checkpoint.repoId !== identity.repoId)
      throw new Error("reconstruction source checkpoint repository does not match the candidate identity");
    const key = candidateKey(missionId, identity.repoId);
    const prior = this.candidates.get(key);
    if (prior && prior.identityHash !== identityHash)
      this.invalidateCandidate(prior, reason ?? "candidate reconstructed from preserved worker work");
    const candidate: CandidateRevision = {
      missionId,
      taskId: checkpoint.taskId,
      executionId: checkpoint.executionId,
      identity,
      identityHash,
      reason: (reason ?? "").trim() || "candidate reconstructed from preserved worker work",
      recordedAt: new Date().toISOString(),
      reconstructedFrom: {
        checkpointId: source.checkpointId,
        branch: source.branch ?? checkpoint.branch,
        candidateSha: identity.candidateSha,
        reconstructedAt: new Date().toISOString(),
      },
    };
    this.candidates.set(key, candidate);
    this.emit("candidate.changed", missionId, { actor: "system", candidate });
    return copyCandidateRevision(candidate);
  }

  getCandidate(missionId: string, repoId?: string): CandidateRevision | undefined {
    const candidates = [...this.candidates.values()].filter((entry) => entry.missionId === missionId);
    const candidate = repoId
      ? this.candidates.get(candidateKey(missionId, repoId))
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    return candidate ? copyCandidateRevision(candidate) : undefined;
  }

  listCandidates(missionId: string): CandidateRevision[] {
    return [...this.candidates.values()].filter((entry) => entry.missionId === missionId).map(copyCandidateRevision);
  }

  evidenceDiagnostics(missionId: string): string[] {
    return [...(this.evidenceReplayErrors.get(missionId) ?? [])];
  }

  recordValidationEvidence(raw: ValidationEvidence): ValidationEvidence {
    this.assertValidationEvidence(raw);
    this.assertUnusedEvidenceExecution(raw.executionId, this.validationEvidence.values());
    const evidence = copyValidationEvidence({
      ...raw,
      recordedAt: this.freshEvidenceTimestamp(raw),
    });
    this.validationEvidence.set(evidence.evidenceId, evidence);
    this.emit("evidence.validation_recorded", evidence.missionId, {
      actor: "system",
      evidence,
    });
    return copyValidationEvidence(evidence);
  }

  listValidationEvidence(missionId?: string): ValidationEvidence[] {
    return [...this.validationEvidence.values()]
      .filter((evidence) => (missionId ? evidence.missionId === missionId : true))
      .map(copyValidationEvidence);
  }

  recordReviewEvidence(raw: ReviewEvidence): ReviewEvidence {
    this.assertReviewEvidence(raw);
    this.assertUnusedEvidenceExecution(raw.executionId, this.reviewEvidence.values());
    const evidence = copyReviewEvidence({
      ...raw,
      recordedAt: this.freshEvidenceTimestamp(raw),
    });
    this.reviewEvidence.set(evidence.evidenceId, evidence);
    this.emit("evidence.review_recorded", evidence.missionId, {
      actor: "system",
      evidence,
    });
    this.lineageReviewRecorded(evidence);
    return copyReviewEvidence(evidence);
  }

  listReviewEvidence(missionId?: string): ReviewEvidence[] {
    return [...this.reviewEvidence.values()]
      .filter((evidence) => (missionId ? evidence.missionId === missionId : true))
      .map(copyReviewEvidence);
  }

  protected assertEvidenceRecord(missionId: string, identity: CandidateEvidenceIdentity, identityHash: string): void {
    this.assertCandidateIdentity(missionId, identity, identityHash);
  }

  protected assertCandidateIdentity(
    missionId: string,
    raw: CandidateEvidenceIdentity,
    identityHash: string,
  ): CandidateEvidenceIdentity {
    if (!this.missions.has(missionId)) throw new Error(`unknown mission ${missionId}`);
    const identity = buildCandidateEvidenceIdentity(raw);
    if (hashCandidateEvidenceIdentity(identity) !== identityHash) throw new Error("malformed candidate evidence hash");
    const manifest = this.workspaceManifests.get(missionId);
    if (!manifest || manifest.hash !== identity.workspaceManifestHash)
      throw new Error("candidate identity does not match the current workspace manifest");
    const binding = manifest.repositories.find((repository) => repository.repoId === identity.repoId);
    if (!binding || binding.baseSha !== identity.baseSha)
      throw new Error("candidate identity does not match the current repository/base");
    return identity;
  }

  protected assertEvidenceProvenance(raw: ValidationEvidence | ReviewEvidence, backend: "validation" | "review"): void {
    this.assertEvidenceRecord(raw.missionId, raw.identity, raw.identityHash);
    const task = this.tasks.get(raw.taskId);
    const execution = this.executions.get(raw.executionId);
    if (!task || !execution) throw new Error("evidence execution is not a successful authoritative execution");
    this.assertSettledExecutionIdentity(task, execution, raw.identity, backend);
    if (
      task.mission_id !== raw.missionId ||
      execution.mission_id !== raw.missionId ||
      execution.task_id !== task.task_id
    )
      throw new Error("evidence provenance mission/task mismatch");
    if (
      task.repo_id !== raw.identity.repoId ||
      execution.repo_id !== raw.identity.repoId ||
      execution.base_sha !== raw.identity.baseSha
    )
      throw new Error("evidence provenance repository mismatch");
  }

  protected assertCandidateProvenance(
    missionId: string,
    identity: CandidateEvidenceIdentity,
    taskId?: string,
    executionId?: string,
  ): void {
    const task = taskId ? this.tasks.get(taskId) : undefined;
    const execution = executionId ? this.executions.get(executionId) : undefined;
    if (!task || !execution) throw new Error("candidate requires a successful authoritative execution");
    this.assertSettledExecutionIdentity(task, execution, identity);
    if (task.mission_id !== missionId || execution.mission_id !== missionId || execution.task_id !== task.task_id)
      throw new Error("candidate provenance mission/task mismatch");
    if (
      task.repo_id !== identity.repoId ||
      execution.repo_id !== identity.repoId ||
      execution.base_sha !== identity.baseSha
    )
      throw new Error("candidate provenance repository mismatch");
  }

  /**
   * Replay-time validation for a reconstructed candidate (#360): the trust
   * anchor is the source checkpoint, whose candidateSha and repoId must match
   * the candidate identity — the same checks recordReconstructedCandidate
   * performs at write time. The source checkpoint's producing execution is
   * deliberately not SUCCEEDED, so assertCandidateProvenance must NOT apply.
   */
  protected assertReconstructedCandidateProvenance(
    missionId: string,
    identity: CandidateEvidenceIdentity,
    source: ReconstructedCandidateSource,
  ): void {
    const checkpoint = this.taskCheckpoints.get(source.checkpointId);
    if (!checkpoint || checkpoint.missionId !== missionId)
      throw new Error(`reconstruction source checkpoint not found for ${missionId}`);
    if (checkpoint.candidateSha !== identity.candidateSha)
      throw new Error("reconstruction source checkpoint sha does not match the candidate identity");
    if (checkpoint.repoId !== identity.repoId)
      throw new Error("reconstruction source checkpoint repository does not match the candidate identity");
  }

  protected assertSettledExecutionIdentity(
    task: OrchestrationTask,
    execution: Execution,
    identity: CandidateEvidenceIdentity,
    backend?: "validation" | "review",
  ): void {
    if (
      execution.status !== "SUCCEEDED" ||
      !execution.ended_at ||
      !Number.isFinite(Date.parse(execution.ended_at)) ||
      (backend !== undefined && execution.backend !== backend)
    )
      throw new Error("evidence execution is not a successful authoritative execution");
    const mismatches = [
      task.mission_generation !== identity.missionGeneration ? "mission generation" : null,
      execution.mission_generation !== identity.missionGeneration ? "execution mission generation" : null,
      task.candidate_generation !== execution.candidate_generation ? "candidate generation" : null,
      task.fencing_token !== execution.fencing_token ? "fencing token" : null,
      task.assigned_execution_id !== execution.execution_id ? "assigned execution" : null,
    ].filter((value): value is string => value !== null);
    if (mismatches.length > 0) throw new Error(`evidence execution is not authoritative: ${mismatches.join(", ")}`);
  }

  protected assertUnusedCandidateExecution(executionId: string): void {
    if (this.candidateExecutionIds.has(executionId))
      throw new Error(`historical execution ${executionId} already recorded candidate evidence`);
  }

  protected assertUnusedEvidenceExecution<T extends { executionId: string }>(
    executionId: string,
    existing: IterableIterator<T>,
  ): void {
    if ([...existing].some((evidence) => evidence.executionId === executionId))
      throw new Error(`historical execution ${executionId} already recorded evidence`);
  }

  protected assertValidationEvidence(raw: ValidationEvidence): void {
    this.assertEvidenceProvenance(raw, "validation");
    if (!raw.command.trim() || !raw.profile.trim() || !Number.isInteger(raw.exitCode))
      throw new Error("malformed validation evidence");
    validateAcceptanceResults(raw.acceptanceResults, raw.identity.acceptanceIds);
  }

  protected assertReviewEvidence(raw: ReviewEvidence): void {
    this.assertEvidenceProvenance(raw, "review");
    if (!raw.reviewerSessionId.trim() || !raw.model.trim() || !raw.provider.trim())
      throw new Error("malformed review evidence identity");
    if (!Array.isArray(raw.findings) || raw.findings.some((finding) => !finding.summary?.trim()))
      throw new Error("malformed review findings");
    validateAcceptanceResults(raw.acceptanceResults, raw.identity.acceptanceIds);
  }

  protected quarantineEvidence(missionId: string, error: unknown): void {
    const diagnostics = this.evidenceReplayErrors.get(missionId) ?? [];
    diagnostics.push(error instanceof Error ? error.message : String(error));
    this.evidenceReplayErrors.set(missionId, diagnostics);
  }

  protected freshEvidenceTimestamp(raw: {
    missionId: string;
    identityHash: string;
    recordedAt: string;
  }): string {
    const latestInvalidation = this.listEvidenceInvalidations(raw.missionId)
      .filter((entry) => hashCandidateEvidenceIdentity(entry.identity) === raw.identityHash)
      .reduce((latest, entry) => Math.max(latest, Date.parse(entry.invalidatedAt)), Number.NEGATIVE_INFINITY);
    const requested = Date.parse(raw.recordedAt);
    const now = Date.now();
    return new Date(Math.max(Number.isFinite(requested) ? requested : now, now, latestInvalidation + 1)).toISOString();
  }

  protected invalidateCurrentCandidate(missionId: string, reason: string): void {
    for (const current of this.listCandidates(missionId)) this.invalidateCandidate(current, reason);
  }

  invalidateRepositoryEvidence(missionId: string, repoId: string, reason: string): void {
    const current = this.candidates.get(candidateKey(missionId, repoId));
    if (current) this.invalidateCandidate(current, reason);
  }

  invalidateRepositoryReviewEvidence(missionId: string, repoId: string, reason: string): void {
    const current = this.candidates.get(candidateKey(missionId, repoId));
    if (!current) return;
    this.invalidateEvidence({
      invalidationId: id("EI"),
      missionId,
      identity: current.identity,
      reason,
      invalidatedAt: new Date().toISOString(),
      scope: "review",
    });
  }

  protected invalidateCandidate(current: CandidateRevision, reason: string): void {
    this.invalidateEvidence({
      invalidationId: id("EI"),
      missionId: current.missionId,
      identity: current.identity,
      reason,
      invalidatedAt: new Date().toISOString(),
      scope: "all",
    });
  }

  listEvidenceInvalidations(missionId?: string): EvidenceInvalidation[] {
    return [...this.evidenceInvalidations.values()]
      .filter((invalidation) => (missionId ? invalidation.missionId === missionId : true))
      .map(copyEvidenceInvalidation);
  }

  getEvidenceInvalidation(invalidationId: string): EvidenceInvalidation | undefined {
    const invalidation = this.evidenceInvalidations.get(invalidationId);
    return invalidation ? copyEvidenceInvalidation(invalidation) : undefined;
  }

  // ── Optional GitHub linkage (T05) ────────────────────────────────────────────

  /** Record (or re-record) an explicit link. Idempotent: an identical active link emits nothing. */
  recordGithubLink(record: GithubLinkRecord): GithubLinkRecord {
    if (!this.missions.has(record.missionId)) throw new Error(`unknown mission ${record.missionId}`);
    const existing = this.githubLinks.get(record.linkId);
    if (existing && existing.status === "active" && record.status === "active") return structuredClone(existing);
    const copy = structuredClone(record);
    this.githubLinks.set(copy.linkId, copy);
    this.emit("github.link_recorded", copy.missionId, { actor: "system", link: copy });
    return structuredClone(copy);
  }

  /** Record a SUGGESTION (never a link). Idempotent per (mission, subject, target); skipped when already linked. */
  suggestGithubLink(suggestion: GithubLinkSuggestion): GithubLinkSuggestion | undefined {
    if (!this.missions.has(suggestion.missionId)) throw new Error(`unknown mission ${suggestion.missionId}`);
    if (this.githubSuggestions.has(suggestion.suggestionId)) return undefined;
    const linked = this.githubLinks.get(linkIdFor(suggestion.missionId, suggestion.subject, suggestion.target));
    if (linked && linked.status === "active") return undefined;
    const copy = structuredClone({ ...suggestion, state: "pending" as const });
    this.githubSuggestions.set(copy.suggestionId, copy);
    this.emit("github.link_suggested", copy.missionId, { actor: "system", suggestion: copy });
    return structuredClone(copy);
  }

  resolveGithubSuggestion(
    suggestionId: string,
    resolution: "confirmed" | "dismissed",
    actor: "user" | "system" = "user",
  ): boolean {
    const existing = this.githubSuggestions.get(suggestionId);
    if (!existing || existing.state !== "pending") return false;
    existing.state = resolution;
    this.emit("github.suggestion_resolved", existing.missionId, { actor, suggestionId, resolution });
    return true;
  }

  /** Apply a reconciliation correction. Returns false (and emits nothing) when it would change nothing. */
  correctGithubLink(linkId: string, patch: GithubLinkPatch, reason: string): boolean {
    const existing = this.githubLinks.get(linkId);
    if (!existing) return false;
    const next = applyGithubLinkPatch(existing, patch);
    if (JSON.stringify(next) === JSON.stringify(existing)) return false;
    this.githubLinks.set(linkId, next);
    this.emit("github.link_corrected", existing.missionId, {
      actor: "system",
      linkId,
      patch: structuredClone(patch),
      reason,
    });
    return true;
  }

  /** Signal that a PR head moved so evidence bound to the old SHA is stale (consumed by T06). Idempotent. */
  recordGithubStale(signal: GithubStaleSignal): boolean {
    if (!this.missions.has(signal.missionId)) throw new Error(`unknown mission ${signal.missionId}`);
    if (this.githubStaleSignals.has(signal.signalId)) return false;
    const copy = structuredClone(signal);
    this.githubStaleSignals.set(copy.signalId, copy);
    this.emit("github.evidence_stale", copy.missionId, { actor: "system", signal: copy });
    return true;
  }

  listGithubLinks(missionId?: string): GithubLinkRecord[] {
    return [...this.githubLinks.values()]
      .filter((l) => !missionId || l.missionId === missionId)
      .map((l) => structuredClone(l));
  }

  getGithubLink(linkId: string): GithubLinkRecord | undefined {
    const link = this.githubLinks.get(linkId);
    return link ? structuredClone(link) : undefined;
  }

  listGithubSuggestions(missionId?: string): GithubLinkSuggestion[] {
    return [...this.githubSuggestions.values()]
      .filter((s) => !missionId || s.missionId === missionId)
      .map((s) => structuredClone(s));
  }

  getGithubSuggestion(suggestionId: string): GithubLinkSuggestion | undefined {
    const s = this.githubSuggestions.get(suggestionId);
    return s ? structuredClone(s) : undefined;
  }

  /**
   * The durable reaction to a stale-evidence signal: a re-review of the new head was requested. Idempotent on the
   * signal id, so a repeated reconcile tick never requests twice. Returns false when already recorded.
   */
  recordGithubRereview(request: GithubRereviewRequest): boolean {
    if (!this.missions.has(request.missionId)) throw new Error(`unknown mission ${request.missionId}`);
    if (this.githubRereviews.has(request.signalId)) return false;
    return this.writeGithubRereview(request);
  }

  /** Replace the record of a request (an in-flight marker, a retry outcome). Replay keeps the last write. */
  updateGithubRereview(request: GithubRereviewRequest): boolean {
    if (!this.githubRereviews.has(request.signalId)) return false;
    return this.writeGithubRereview(request);
  }

  getGithubRereview(signalId: string): GithubRereviewRequest | undefined {
    const r = this.githubRereviews.get(signalId);
    return r ? structuredClone(r) : undefined;
  }

  protected writeGithubRereview(request: GithubRereviewRequest): boolean {
    const copy = structuredClone(request);
    this.githubRereviews.set(copy.signalId, copy);
    this.emit("github.rereview_requested", copy.missionId, { actor: "system", request: copy });
    return true;
  }

  /**
   * The merge-gate decision for a PR, with a revision that moves only when (head, decision) CHANGES. The revision
   * goes into the lineage event ids: a replay of the same decision dedupes, a flip (merge -> wait -> merge) is a new
   * event, so Herdr's final state follows Pi's. Returns the current record and what it replaced.
   */
  recordGithubGate(
    missionId: string,
    target: string,
    head: string,
    decision: string,
  ): {
    gate: GithubGateDecision;
    previous: GithubGateDecision | undefined;
  } {
    const previous = this.githubGates.get(target);
    if (previous && previous.head === head && previous.decision === decision)
      return { gate: structuredClone(previous), previous: structuredClone(previous) };
    const gate: GithubGateDecision = { missionId, target, head, decision, revision: (previous?.revision ?? 0) + 1 };
    this.githubGates.set(target, gate);
    this.emit("github.gate_decided", missionId, { actor: "system", gate: structuredClone(gate) });
    return { gate: structuredClone(gate), previous: previous ? structuredClone(previous) : undefined };
  }

  /** What the plan CLI last projected for a mission (so a re-plan can withdraw what the new plan dropped). */
  getDagProjection(missionId: string): DagProjection | undefined {
    const d = this.dagProjections.get(missionId);
    return d ? structuredClone(d) : undefined;
  }

  recordDagProjection(projection: DagProjection): void {
    this.dagProjections.set(projection.missionId, structuredClone(projection));
    this.emit("dag.projected", projection.missionId, { actor: "system", projection: structuredClone(projection) });
  }

  listGithubRereviews(missionId?: string): GithubRereviewRequest[] {
    return [...this.githubRereviews.values()]
      .filter((r) => !missionId || r.missionId === missionId)
      .map((r) => structuredClone(r));
  }

  listGithubStaleSignals(missionId?: string): GithubStaleSignal[] {
    return [...this.githubStaleSignals.values()]
      .filter((s) => !missionId || s.missionId === missionId)
      .map((s) => structuredClone(s));
  }

  transitionMissionLease(transition: LeaseTransition, lease: MissionLease): MissionLease {
    this.applyLeaseTransition(transition, "mission", lease);
    return { ...lease };
  }

  getMissionLease(missionId: string): MissionLease | undefined {
    const lease = this.missionLeases.get(missionId);
    return lease ? { ...lease } : undefined;
  }

  getLatestMissionLease(missionId: string): MissionLease | undefined {
    const lease = this.missionLeaseEpochs.get(missionId);
    return lease ? { ...lease } : undefined;
  }

  transitionRepositoryLease(transition: LeaseTransition, lease: RepositoryLease): RepositoryLease {
    this.applyLeaseTransition(transition, "repository", lease);
    return { ...lease };
  }

  listRepositoryLeases(missionId?: string): RepositoryLease[] {
    return [...this.repositoryLeases.values()]
      .filter((lease) => (missionId ? lease.missionId === missionId : true))
      .map((lease) => ({ ...lease }));
  }

  getRepositoryLease(missionId: string, repoId: string): RepositoryLease | undefined {
    const lease = this.repositoryLeases.get(repoId);
    return lease?.missionId === missionId ? { ...lease } : undefined;
  }

  getRepositoryLeaseByRepoId(repoId: string): RepositoryLease | undefined {
    const lease = this.repositoryLeases.get(repoId);
    return lease ? { ...lease } : undefined;
  }

  getLatestRepositoryLease(repoId: string): RepositoryLease | undefined {
    const lease = this.repositoryLeaseEpochs.get(repoId);
    return lease ? { ...lease } : undefined;
  }
}
