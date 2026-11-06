import { randomUUID } from "node:crypto";
import { type ToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import type { ContextBroker } from "../context/ContextBroker.ts";
import { type Actor, type Evidence, isMachineEvidence } from "../core/types.ts";
import type { Ledger } from "../ledger/Ledger.ts";
import { countClaims, countGuardMessage, countsAreBacked, metricsFromOutput } from "../ledger/claimDiscipline.ts";
import { MissionRefusedError, missionRefusalText } from "../orchestration/missionRefusal.ts";
import type { OrchestrateResult, Orchestrator } from "../orchestration/orchestrator.ts";
import type { Mission } from "../orchestration/types.ts";
import { lookupMissionDurable } from "../runtime/host/durableMissionLookup.ts";
import { missionReportLines } from "./missionReport.ts";

/** Shared services bound to the current repository's runtime. */
export interface CoreServices {
  ledger: Ledger;
  artifacts: ArtifactStore;
  broker: ContextBroker | null;
  currentWorkItemId: () => string | null;
  actor: () => Actor;
  /** Optional orchestrator for automatic intent-driven missions (spec 06). */
  orchestrator?: Orchestrator | null;
  /** Resolve the current repo base ref. */
  baseRef?: () => Promise<string> | string;
  /** Authorized repository selected for this tool execution. */
  repoId?: string;
  repositoryRoot?: string;
  /**
   * Operator recovery of a durably stopped mission — what `/mission resume`
   * runs (EngineeringRuntime.resumeBlockedMission). Optional: without it the
   * mission tool's `resume` action points at the slash command.
   */
  resumeMission?: (missionId: string, signal?: AbortSignal) => Promise<Mission>;
  /** Explicitly cancel a mission (the only thing that terminates a healthy one). */
  cancelMission?: (missionId: string) => Promise<Mission>;
  /**
   * Pause one named mission (what `/mission pause` runs). Optional: without it
   * the mission tool's `pause` action points at the slash command.
   */
  pauseMission?: (missionId: string) => Promise<Mission>;
  /** Release a mission from its operator model pin (back to automatic routing). */
  clearMissionModelPin?: (missionId: string) => Promise<Mission>;
}

/** Resolve a machine reference rather than trusting an agent-supplied prefix. */
export async function hasRecordedEvidence(
  ref: string | undefined,
  services: Pick<CoreServices, "ledger" | "artifacts">,
): Promise<boolean> {
  if (!ref || !isMachineEvidence(ref)) return false;
  if (ref.startsWith("artifact://")) {
    try {
      // Metadata discovery is deliberately cheap and does not authenticate
      // content. A bounded page validates the full digest on first access and
      // reuses it only while the pinned file's identity remains unchanged.
      return (
        services.artifacts.getByUri(ref) !== undefined &&
        (await services.artifacts.readSliceByUri(ref, 0, 1)) !== undefined
      );
    } catch {
      return false;
    }
  }
  const id = ref.startsWith("test-run://") ? ref.slice("test-run://".length) : ref;
  const evidence = services.ledger.getEvidence(id);
  return evidence !== undefined && evidence.trust !== "unverified";
}

/** How much stored output the count guard reads from each end of an artifact. */
const COUNT_GUARD_HEAD_CHARS = 8_000;
const COUNT_GUARD_TAIL_CHARS = 24_000;

/**
 * The largest captured output `ledger_evidence` stores. A command that printed
 * megabytes is not evidence of anything extra; the tail of a stack trace is what
 * a reader needs, and an unbounded string in the ledger is a memory hazard.
 */
const MAX_EVIDENCE_OUTPUT_CHARS = 200_000;

/** Evidence type labels are free-form but canonical: `repro`, `verify.unit`, `probe.api`. */
const EVIDENCE_KIND_RE = /^[a-z][a-z0-9._-]{1,40}$/;

/** The trust of the evidence entity behind a reference; an artifact:// URI carries no trust of its own. */
function evidenceTrust(ref: string | undefined, services: Pick<CoreServices, "ledger">): Evidence["trust"] | null {
  if (!ref || ref.startsWith("artifact://")) return null;
  const id = ref.startsWith("test-run://") ? ref.slice("test-run://".length) : ref;
  return services.ledger.getEvidence(id)?.trust ?? null;
}

/**
 * The stored output behind an evidence reference: both ends, because a test
 * runner prints its plan at the start (`1..12`) and its summary at the end
 * (`# tests 12`), and a count may be reported at either.
 */
async function evidenceOutputText(
  ref: string,
  services: Pick<CoreServices, "ledger" | "artifacts">,
): Promise<{ evidence: Evidence | null; text: string | null }> {
  const readWindow = async (uri: string): Promise<string | null> => {
    try {
      const meta = services.artifacts.getByUri(uri);
      const size = meta?.size ?? 0;
      if (!meta || size <= COUNT_GUARD_HEAD_CHARS + COUNT_GUARD_TAIL_CHARS) {
        const whole = await services.artifacts.readSliceByUri(uri, 0, Math.max(size, COUNT_GUARD_TAIL_CHARS));
        return whole?.content ?? null;
      }
      const [head, tail] = await Promise.all([
        services.artifacts.readSliceByUri(uri, 0, COUNT_GUARD_HEAD_CHARS),
        services.artifacts.readSliceByUri(uri, size - COUNT_GUARD_TAIL_CHARS, COUNT_GUARD_TAIL_CHARS),
      ]);
      return [head?.content, tail?.content].filter((part): part is string => typeof part === "string").join("\n…\n");
    } catch {
      return null;
    }
  };
  if (ref.startsWith("artifact://")) return { evidence: null, text: await readWindow(ref) };
  const id = ref.startsWith("test-run://") ? ref.slice("test-run://".length) : ref;
  const evidence = services.ledger.getEvidence(id) ?? null;
  if (!evidence) return { evidence: null, text: null };
  const windows = await Promise.all((evidence.artifacts ?? []).slice(0, 2).map((uri) => readWindow(uri)));
  const text = windows.filter((w): w is string => typeof w === "string").join("\n");
  return { evidence, text: text.length > 0 ? text : null };
}

/**
 * The semantic tools the runtime exposes to both the interactive session and
 * fresh-context workers (spec §10.3, §8.3 role tool schemas). They return compact
 * summaries and artifact references rather than bulk content.
 *
 * `resolve(cwd)` returns the services for a working directory, so the same tool
 * definitions work in the interactive session (resolved by the current cwd) and
 * in worker sessions (bound to the runtime's fixed services).
 */
/** Why a mission's current stop waits for the user, or null when the runtime may resume it. */
function awaitingUser(store: Orchestrator["store"], mission: Mission): string | null {
  if (mission.status === "WAITING_FOR_USER") return "status WAITING_FOR_USER";
  const generation = store.listMissionResumptions(mission.mission_id).at(-1)?.generation ?? 0;
  const decision = store
    .listRecoveryDecisions(mission.mission_id)
    .filter((candidate) => (candidate.resumptionGeneration ?? 0) === generation)
    .at(-1);
  if (!decision) return null;
  if (decision.action === "WAIT_FOR_REQUIREMENT") {
    return decision.operatorGuidance
      ? `requirement clarification, ${decision.operatorGuidance}`
      : "requirement clarification";
  }
  const category = store.getFailureClassification(decision.classificationId)?.category;
  if (category === "AUTHORIZATION_OR_CREDENTIAL") return "authorization or credentials";
  if (category === "REQUIREMENT_AMBIGUITY") return "requirement clarification";
  return null;
}

/** What a tool reports when its runtime service is unavailable for the cwd, with the reason when known. */
export function notInitializedText(subject: string, reason: string | null | undefined): string {
  return reason
    ? `${subject} not initialized for this directory: ${reason}`
    : `${subject} not initialized for this directory.`;
}

export function buildCoreTools(
  resolve: (cwd: string) => CoreServices | null | Promise<CoreServices | null>,
  options: {
    /** Why services are unavailable for a cwd (the real open failure), surfaced in tool results. */
    unavailableReason?: (cwd: string) => string | null | undefined;
  } = {},
): ToolDefinition[] {
  const servicesFor = (cwd: string): Promise<CoreServices | null> => Promise.resolve(resolve(cwd));
  const notInitialized = (subject: string, cwd: string): string =>
    notInitializedText(subject, options.unavailableReason?.(cwd));
  const ledgerRead = defineTool({
    name: "ledger_read",
    label: "Ledger Read",
    description:
      "Query the Engineering Ledger (facts, hypotheses, findings, decisions, requirements, candidates, evidence). Returns compact entity summaries.",
    parameters: Type.Object({
      kind: Type.Optional(
        Type.String({
          description:
            "Entity kind to filter: fact, hypothesis, finding, decision, requirement, invariant, candidate, evidence",
        }),
      ),
      work_item_id: Type.Optional(Type.String({ description: "Work item to scope the query" })),
      limit: Type.Optional(Type.Number({ description: "Max entities to return" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const services = await servicesFor(ctx.cwd);
      if (!services)
        return {
          content: [{ type: "text", text: notInitialized("Engineering runtime", ctx.cwd) }],
          details: {},
        };
      const wi = (params.work_item_id as string | undefined) ?? services.currentWorkItemId();
      let entities = services.ledger.listEntities(undefined, wi ?? undefined);
      if (params.kind) {
        const k = String(params.kind);
        if (k === "candidate" || k === "evidence") {
          const rows =
            k === "candidate"
              ? services.ledger.listCandidates(wi ?? undefined).map((c) => ({
                  id: c.id,
                  work_item_id: c.work_item_id,
                  status: c.status,
                  branch: c.branch,
                  base_commit: c.base_commit,
                  evidence_ids: c.evidence_ids,
                  rejection_reason: c.rejection_reason,
                }))
              : // listEvidence filters by candidate id only; when scoped to a work
                // item, resolve that item's candidate ids first so evidence rows
                // are actually scoped to the work item (not the whole store).
                (() => {
                  const candIds = wi ? new Set(services.ledger.listCandidates(wi).map((c) => c.id)) : null;
                  return services.ledger
                    .listEvidence()
                    .filter((e) => !candIds || (e.candidate_id != null && candIds.has(e.candidate_id)))
                    .map((e) => ({
                      id: e.id,
                      type: e.type,
                      status: e.status,
                      trust: e.trust,
                      exit_code: e.exit_code,
                      summary: e.summary,
                      artifacts: e.artifacts,
                    }));
                })();
          return {
            content: [{ type: "text", text: JSON.stringify(rows.slice(0, params.limit ?? 20), null, 2) }],
            details: { rows },
          };
        }
        entities = entities.filter((e) => e.kind === k);
      }
      const rows = entities.slice(-(params.limit ?? 20)).map((e) => ({
        id: e.id,
        kind: e.kind,
        status: e.status,
        claim: e.claim.slice(0, 200),
        evidence: e.evidence,
        confidence: e.confidence,
        severity: e.severity,
        candidate_id: e.candidate_id,
      }));
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { rows } };
    },
  });

  const ledgerClaim = defineTool({
    name: "ledger_claim",
    label: "Ledger Claim",
    description:
      "Record an unverified hypothesis or an evidence-backed fact/finding into the Engineering Ledger. Hypotheses stay open even with evidence. Cite stored evidence for observations; a heartbeat proves liveness, not progress, and failed or unauthorized probes leave live state unknown. A reference does not establish a causal explanation. A claim that states a count (tests, commits, files, lines) must cite the machine output that produced that number — an evidence id or artifact:// whose stored output reports it — or the claim is refused.",
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal("fact"),
        Type.Literal("hypothesis"),
        Type.Literal("finding"),
        Type.Literal("decision"),
      ]),
      claim: Type.String({ description: "The claim text" }),
      evidence: Type.Optional(Type.String({ description: "Evidence reference, or omit if unverified" })),
      severity: Type.Optional(Type.String({ description: "For findings: info, low, medium, high, critical" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const services = await servicesFor(ctx.cwd);
      if (!services)
        return {
          content: [{ type: "text", text: notInitialized("Engineering runtime", ctx.cwd) }],
          details: {},
        };
      const ref = params.evidence ? String(params.evidence) : undefined;
      // Prefixes classify references; they cannot authenticate evidence (INV-006).
      const machine = await hasRecordedEvidence(ref, services);
      // A count is the easiest claim to invent, so it never enters on a bare
      // assertion: the number must appear in the machine output cited (issue #507).
      const counts = countClaims(String(params.claim));
      if (counts.length > 0) {
        const backed = ref && machine ? await evidenceOutputText(ref, services) : { evidence: null, text: null };
        const { ok, unbacked } = countsAreBacked(counts, backed.evidence, backed.text);
        if (!ok) {
          return {
            content: [{ type: "text", text: countGuardMessage(unbacked, ref) }],
            details: { refused: "count_without_metric_evidence", unbacked },
          };
        }
      }
      const status = params.kind === "finding" || params.kind === "hypothesis" ? "open" : machine ? "verified" : "open";
      const entity = await services.ledger.recordEntity(
        params.kind as "fact" | "hypothesis" | "finding" | "decision",
        String(params.claim),
        status as never,
        services.actor(),
        services.currentWorkItemId(),
        { evidence: machine ? [String(params.evidence)] : [], severity: params.severity as never },
      );
      // Saying *how* the evidence is backed is part of the answer: an `observed`
      // record is output a caller supplied, which is inspectable but is not the
      // runtime having run the command itself.
      const trust = evidenceTrust(ref, services);
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${entity.kind} ${entity.id} (status ${entity.status}). ${
              machine
                ? `Evidence reference resolved; causal interpretations still require independent verification.${
                    trust === "observed"
                      ? " That evidence is output its recorder supplied (trust observed): inspectable and immutable, but the runtime did not run the command."
                      : ""
                  }`
                : "No recorded machine evidence; treat this as an unverified claim."
            }`,
          },
        ],
        details: {
          id: entity.id,
          kind: entity.kind,
          status: entity.status,
          evidenceResolved: machine,
          backedBy: trust,
        },
      };
    },
  });

  const ledgerEvidence = defineTool({
    name: "ledger_evidence",
    label: "Ledger Evidence",
    description:
      "Record the output of a command you ran as durable ledger evidence, so a finding or claim can cite something inspectable instead of a paraphrase. The runtime derives everything it can from what you give it: status comes from the exit code, and metrics (tests, files, lines, commits) are parsed out of the output text itself — there is no parameter for a count, a status, or a trust level, because a number the caller asserts is not a measurement. Trust is always `observed`: the runtime did not run this command, so the record is attested output that a reviewer can re-run, not proof. Returns the EVID-… id to cite in ledger_claim, and can attach the record to an existing entity.",
    parameters: Type.Object({
      command: Type.String({ description: "The exact command line that produced the output" }),
      output: Type.String({ description: "The captured stdout+stderr of that command" }),
      exit_code: Type.Integer({ minimum: -1, description: "The process exit code (0 is what the command reported)" }),
      kind: Type.Optional(
        Type.String({ description: "Evidence type: repro | verify.unit | probe.api … (default repro)" }),
      ),
      entity: Type.Optional(Type.String({ description: "Ledger entity id to attach the record to (FND-…, FACT-…)" })),
      candidate: Type.Optional(Type.String({ description: "Candidate id the record certifies (CND-…)" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const services = await servicesFor(ctx.cwd);
      if (!services)
        return {
          content: [{ type: "text", text: notInitialized("Engineering runtime", ctx.cwd) }],
          details: {},
        };
      const refuse = (text: string, refused: string) => ({
        content: [{ type: "text" as const, text }],
        details: { refused },
        isError: true as const,
      });
      const command = String(params.command ?? "").trim();
      if (!command)
        return refuse("Refused: no command. Evidence without provenance is an anonymous blob.", "no_command");
      const exitCode = Number(params.exit_code);
      if (!Number.isInteger(exitCode))
        return refuse(
          "Refused: exit_code must be an integer — status is derived from it, never asserted.",
          "bad_exit_code",
        );
      const kind = params.kind ? String(params.kind) : "repro";
      if (!EVIDENCE_KIND_RE.test(kind))
        return refuse(`Refused: kind "${kind}" must match ${EVIDENCE_KIND_RE.source}.`, "bad_kind");
      const captured = typeof params.output === "string" ? params.output : "";
      if (captured.trim().length === 0)
        return refuse(
          "Refused: empty output. Record what the command printed, not a summary of it — a paraphrase is the claim this tool exists to support.",
          "empty_output",
        );
      const truncated = captured.length > MAX_EVIDENCE_OUTPUT_CHARS;
      const content = truncated
        ? `${captured.slice(0, MAX_EVIDENCE_OUTPUT_CHARS)}\n… [ledger_evidence truncated the capture at ${MAX_EVIDENCE_OUTPUT_CHARS} characters]\n`
        : captured;
      // The metrics are read out of the stored text here, so the number a later
      // count guard looks for is the number this artifact actually contains.
      const { metrics, ambiguous } = metricsFromOutput(content);
      const artifact = await services.artifacts.put(
        "evidence",
        `evidence-${randomUUID()}`,
        content,
        `exit ${exitCode}: ${content.slice(0, 500)}`,
      );
      const recorded = await services.ledger.recordEvidence(
        params.candidate ? String(params.candidate) : null,
        kind,
        command.split(/\s+/)[0]!,
        command,
        exitCode,
        exitCode === 0 ? "passed" : "failed",
        {
          exitCode,
          outputChars: content.length,
          ...(truncated ? { truncated: true } : {}),
          ...metrics,
          ...(ambiguous.length > 0 ? { ambiguousMetrics: ambiguous } : {}),
        },
        [artifact.uri],
        // The runtime did not run this command. Nothing in the parameters can
        // raise that: `deterministic` and `authoritative` belong to verification
        // the runtime performed itself (src/verify/Verifier.ts).
        "observed",
        services.currentWorkItemId(),
        services.actor(),
      );
      let attached = false;
      if (params.entity) {
        const updated = await services.ledger.attachEvidence(
          String(params.entity),
          recorded.id,
          services.currentWorkItemId(),
          services.actor(),
        );
        attached = updated !== null;
      }
      const stated = Object.entries(metrics)
        .map(([noun, value]) => `${noun}=${value}`)
        .join(", ");
      return {
        content: [
          {
            type: "text",
            text: `Recorded ${recorded.id} (type ${kind}, trust observed, status ${recorded.status}, exit ${exitCode}) at ${artifact.uri}. ${
              stated
                ? `Metrics read from the output: ${stated}${ambiguous.length ? ` (ambiguous: ${ambiguous.join(", ")})` : ""}. `
                : "No counts appear in the output. "
            }${
              params.entity
                ? attached
                  ? `Attached to ${String(params.entity)}. `
                  : `Nothing attached: entity ${String(params.entity)} does not exist, though the evidence record stands. `
                : ""
            }Cite it in ledger_claim as evidence: "${recorded.id}". Attested output — re-run the command to prove it.`,
          },
        ],
        details: {
          id: recorded.id,
          uri: artifact.uri,
          kind,
          trust: recorded.trust,
          status: recorded.status,
          exitCode,
          metrics,
          ...(ambiguous.length > 0 ? { ambiguousMetrics: ambiguous } : {}),
          truncated,
          attached,
        },
      };
    },
  });

  const artifactRead = defineTool({
    name: "artifact_read",
    label: "Artifact Read",
    description:
      "Lazily read a stored artifact (log, diff, report) by its artifact:// URI. Large artifacts are returned in bounded slices; use offset to page through the rest on demand.",
    parameters: Type.Object({
      uri: Type.String({ description: "artifact:// URI to read" }),
      offset: Type.Optional(Type.Number({ description: "Character offset to start reading from (for pagination)" })),
      max_chars: Type.Optional(Type.Number({ description: "Cap the returned slice length" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const services = await servicesFor(ctx.cwd);
      if (!services)
        return {
          content: [{ type: "text", text: notInitialized("Engineering runtime", ctx.cwd) }],
          details: {},
        };
      const meta = services.artifacts.getByUri(String(params.uri));
      if (!meta)
        return { content: [{ type: "text", text: "Artifact not found." }], details: { found: false }, isError: true };
      const offset = params.offset ? Math.max(0, Number(params.offset)) : 0;
      const cap = params.max_chars ? Math.max(1, Number(params.max_chars)) : 12000;
      let read;
      try {
        read = await services.artifacts.readSliceByUri(String(params.uri), offset, cap);
      } catch (error) {
        return {
          content: [{ type: "text", text: `Artifact integrity failure: ${String(error)}` }],
          details: { found: false },
          isError: true,
        };
      }
      // A missing content file must surface as an error, not a silent empty
      // result (a reviewer would otherwise judge an empty diff and could
      // report no findings, enabling silent promotion).
      if (read == null) {
        return {
          content: [{ type: "text", text: "Artifact metadata exists but its content file is missing." }],
          details: { found: false },
          isError: true,
        };
      }
      const slice = read.content;
      const more = offset + cap < meta.size;
      const out = more
        ? `${slice}\n… [truncated; call artifact_read with offset=${read.nextOffset} to continue]`
        : slice;
      return {
        content: [{ type: "text", text: out }],
        details: { uri: meta.uri, size: meta.size, summary: meta.summary, offset, more },
      };
    },
  });

  const repoSearch = defineTool({
    name: "repo_search",
    label: "Repo Search",
    description: "Search the repository for symbols or text (bounded result set).",
    parameters: Type.Object({
      query: Type.String({ description: "Search term or pattern" }),
      limit: Type.Optional(Type.Number({ description: "Max hits" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const services = await servicesFor(ctx.cwd);
      if (!services)
        return {
          content: [{ type: "text", text: notInitialized("Engineering runtime", ctx.cwd) }],
          details: {},
        };
      if (!services.broker) return { content: [{ type: "text", text: "Not a git repository." }], details: {} };
      const hits = await services.broker.search(String(params.query), params.limit ?? 40);
      const text = hits.length ? hits.map((h) => `${h.path}:${h.line} — ${h.text}`).join("\n") : "No matches.";
      return {
        content: [{ type: "text", text }],
        details: { hits: hits.length, ...(services.repoId ? { repoId: services.repoId } : {}) },
      };
    },
  });

  const symbol = defineTool({
    name: "symbol",
    label: "Symbol",
    description: "Read a bounded slice of a repository file to inspect a symbol or context.",
    parameters: Type.Object({
      path: Type.String({ description: "File path relative to repo root" }),
      offset: Type.Optional(Type.Number({ description: "Starting line (0-based)" })),
      limit: Type.Optional(Type.Number({ description: "Number of lines" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const services = await servicesFor(ctx.cwd);
      if (!services)
        return {
          content: [{ type: "text", text: notInitialized("Engineering runtime", ctx.cwd) }],
          details: {},
        };
      if (!services.broker) return { content: [{ type: "text", text: "Not a git repository." }], details: {} };
      const text = await services.broker.readSlice(String(params.path), params.offset ?? 0, params.limit ?? 120);
      if (text === null)
        return { content: [{ type: "text", text: "File not found." }], details: { found: false }, isError: true };
      return { content: [{ type: "text", text }], details: { path: params.path } };
    },
  });

  const testsFor = defineTool({
    name: "tests_for",
    label: "Tests For",
    description: "Discover test files relevant to given symbols.",
    parameters: Type.Object({
      symbols: Type.Array(Type.String()),
      limit: Type.Optional(Type.Number()),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const services = await servicesFor(ctx.cwd);
      if (!services)
        return {
          content: [{ type: "text", text: notInitialized("Engineering runtime", ctx.cwd) }],
          details: {},
        };
      if (!services.broker) return { content: [{ type: "text", text: "Not a git repository." }], details: {} };
      const tests = await services.broker.testsFor(params.symbols as string[], params.limit ?? 20);
      return {
        content: [{ type: "text", text: tests.length ? tests.join("\n") : "No relevant tests found." }],
        details: { tests },
      };
    },
  });

  const mission = defineTool({
    name: "mission",
    label: "Mission",
    description:
      "Run the orchestration mission pipeline for a normal-language engineering request: route intent, plan, execute workers, validate, fresh-review, and gate completion. Use this for implement/fix/refactor/investigate requests so the engineering workflow runs automatically. action=status reports an existing mission; action=resume recovers a stopped/blocked/paused mission (same as /mission resume <id>); a stop that waits for the user is refused. Interrupting a run pauses the mission (resumable); only action=cancel ends it — use cancel only when the user explicitly asks to cancel.",
    parameters: Type.Object({
      action: Type.Optional(
        Type.Union(
          [
            Type.Literal("run"),
            Type.Literal("status"),
            Type.Literal("resume"),
            Type.Literal("pause"),
            Type.Literal("cancel"),
            Type.Literal("clear_pin"),
          ],
          {
            description:
              "run (default) starts a mission from `request`; status/resume/pause/cancel/clear_pin act on `missionId`. pause stops one named mission and keeps its work (resume continues it); cancel ends one. clear_pin releases the mission from the operator's /model pin (automatic routing).",
          },
        ),
      ),
      request: Type.Optional(
        Type.String({ description: "The normal-language request (e.g. 'Add a health endpoint'). Required for run." }),
      ),
      missionId: Type.Optional(Type.String({ description: "Mission id for status/resume (e.g. MSN-abc123)." })),
      mutate: Type.Optional(
        Type.Boolean({
          description: "Whether the request mutates repository source (default true for implement/fix).",
        }),
      ),
      constraints: Type.Optional(Type.Array(Type.String({ description: "Constraints to apply" }))),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const services = await servicesFor(ctx.cwd);
      const text = (body: string, details: Record<string, unknown> = {}) => ({
        content: [{ type: "text" as const, text: body }],
        details,
      });
      if (!services?.orchestrator) {
        const reason = options.unavailableReason?.(ctx.cwd);
        return text(
          notInitializedText("Orchestrator", reason),
          reason ? { diagnostics: [{ code: "orchestrator_init_failed", cwd: ctx.cwd, message: reason }] } : {},
        );
      }
      const store = services.orchestrator.store as Orchestrator["store"] | undefined;
      const action = (params.action as string | undefined) ?? "run";
      const describe = (m: Mission, extra: string[] = []) =>
        text(
          [
            `Mission ${m.mission_id} [${m.status}] workflow=${m.workflow_class}`,
            ...extra,
            ...(store ? missionReportLines(store, m.mission_id) : []),
          ].join("\n"),
          {
            missionId: m.mission_id,
            status: m.status,
          },
        );

      // (#427) A miss in the live store is answered from the durable event
      // log before saying `Unknown mission`: the replay projection proves
      // whether the mission exists at all, and every mutation is reported
      // against the replay view instead of being silently refused.
      const durableMiss = async (verb: string, missionId: string) => {
        const durable = await lookupMissionDurable(ctx.cwd, missionId).catch(() => undefined);
        if (!durable) return text(`Unknown mission ${missionId}.`);
        return text(
          [
            `Mission ${durable.mission.mission_id} [${durable.mission.status}] workflow=${durable.mission.workflow_class}`,
            `Durable replay view (#427): the event log knows this mission but this session holds no live runtime for it — the ${verb} was NOT performed.`,
            ...missionReportLines(durable.store, missionId),
            durable.mission.status === "BLOCKED" || durable.mission.status === "REPAIRING"
              ? `Next step: the session that owns it resumes; or start a fresh mission — the preserved work is on the branches listed above.`
              : `Next step: none needed through this tool; the owning session reports status.`,
          ].join("\n"),
          {
            missionId,
            status: durable.mission.status,
            diagnostics: [
              {
                code: "durable_replay_view",
                cwd: ctx.cwd,
                message: "mission found in durable events, not live in this session",
              },
            ],
          },
        );
      };
      if (action === "clear_pin") {
        const missionId = String(params.missionId ?? "").trim();
        if (!missionId) return text("The clear_pin action needs missionId.");
        const current = store?.getMission(missionId);
        if (!current) return await durableMiss("pin release", missionId);
        if (!services.clearMissionModelPin) {
          return text(
            `Clearing a pin is not available through the tool in this session. Ask the operator to run /mission resume ${missionId} --model auto.`,
            { missionId, status: current.status },
          );
        }
        const released = await services.clearMissionModelPin(missionId);
        return describe(released, [
          "Operator pin released: the mission uses role pins and the router from its next dispatch.",
        ]);
      }
      if (action === "pause") {
        const missionId = String(params.missionId ?? "").trim();
        if (!missionId) return text("The pause action needs missionId.");
        const current = store?.getMission(missionId);
        if (!current) return text(`Unknown mission ${missionId}.`);
        // Pause is mission-scoped and needs no live turn: the store records it,
        // then whatever is live is stopped or parked. Only resume un-parks it.
        if (!services.pauseMission) {
          return text(
            `Pausing is not available through the tool in this session. Ask the operator to run /mission pause ${missionId}.`,
            {
              missionId,
              status: current.status,
            },
          );
        }
        const paused = await services.pauseMission(missionId);
        return describe(paused, [`Operator pause recorded — resume with /mission resume ${missionId}.`]);
      }
      if (action === "cancel") {
        const missionId = String(params.missionId ?? "").trim();
        if (!missionId) return text("The cancel action needs missionId.");
        const current = store?.getMission(missionId);
        if (!current) return await durableMiss("cancellation", missionId);
        if (!services.cancelMission) {
          return text(
            `Cancel is not available through the tool in this session. Ask the operator to run /mission cancel ${missionId}.`,
            {
              missionId,
              status: current.status,
            },
          );
        }
        const canceled = await services.cancelMission(missionId);
        return describe(canceled, ["Canceled at the operator's request."]);
      }
      if (action === "status" || action === "resume") {
        const missionId = String(params.missionId ?? "").trim();
        if (!missionId) return text(`The ${action} action needs missionId.`);
        const current = store?.getMission(missionId);
        if (!current)
          return await durableMiss(action === "status" ? "status read (no change attempted)" : "resume", missionId);
        if (action === "status") return describe(current);
        // Resuming a stop that waits for the user (a requirement question, a
        // credential the user must fix) is the user's call, not the model's:
        // the tool refuses and points at the operator command.
        const awaiting = store ? awaitingUser(store, current) : null;
        if (awaiting) {
          return describe(current, [
            `Resume refused: the mission is waiting for the user (${awaiting}). Ask the user; after they respond they can run /mission resume ${missionId}.`,
          ]);
        }
        if (!services.resumeMission) {
          return text(
            `Resume is not available through the tool in this session. Ask the operator to run /mission resume ${missionId}.`,
            { missionId, status: current.status },
          );
        }
        try {
          const resumed = await services.resumeMission(missionId, signal);
          return describe(resumed, ["Resume requested."]);
        } catch (error) {
          return describe(current, [`Resume failed: ${error instanceof Error ? error.message : String(error)}`]);
        }
      }

      const request = String(params.request ?? "").trim();
      if (!request) return text("The run action needs a request.");
      let result: OrchestrateResult;
      try {
        result = await services.orchestrator.orchestrate(request, {
          repository: services.repositoryRoot ?? ctx.cwd,
          // The orchestrator resolves the request's explicit repository before
          // choosing a base. Forwarding the caller cwd's SHA can bind an external
          // target mission to an unrelated launch repository commit.
          baseRef: "",
          constraints: (params.constraints as string[] | undefined) ?? [],
          mutationRequested: params.mutate ?? true,
          signal,
          // Interrupting the call (Esc) pauses the mission; it never cancels it.
          interrupt: "pause",
          // Stream every live progress line (phase/task transitions + progress
          // bar) to the operator via the tool update callback instead of blocking
          // silently for the whole mission.
          onProgress: (line: string) => {
            _onUpdate?.({ content: [{ type: "text", text: line }], details: {} });
          },
        });
      } catch (error) {
        // #511: a delegation the runtime refused while maintenance drains is a
        // result the caller can act on — retry after a wait, resume later — not
        // an unlabelled tool failure the caller absorbs as "nothing to do".
        if (error instanceof MissionRefusedError) {
          return {
            content: [{ type: "text", text: missionRefusalText(error) }],
            details: {
              delegationBlocked: true,
              reason: error.reason,
              retryAfterMs: error.retryAfterMs,
              draining: error.draining,
              resumeHint: error.resumeHint,
            },
          };
        }
        throw error;
      }
      const m = result.mission;
      const statusLine =
        result.pausedBy === "operator" && m.status !== "PAUSED_INFRASTRUCTURE"
          ? `Interrupt noted: the mission was left ${m.status} and was not canceled. /mission resume ${m.mission_id} continues it; /mission cancel ${m.mission_id} ends it.`
          : result.pausedBy === "operator"
            ? `PAUSED by interrupt: the mission was not canceled and its progress is preserved. Resume it with /mission resume ${m.mission_id} (or this tool's resume action); /mission cancel ${m.mission_id} ends it.`
            : result.paused
              ? "PAUSED: infrastructure retry window exhausted. Progress is preserved; the mission auto-resumes when the gateway recovers (it is not a failure)."
              : result.completed
                ? "Completed: all gates passed."
                : `Not completed: ${result.failureReason ?? "gates unmet"}.`;
      const lines = [
        `Mission ${m.mission_id} [${m.status}] workflow=${m.workflow_class}`,
        `Intent: ${result.intent.intent.join(", ")} | required gates: ${m.required_gates.join(", ") || "none"}`,
        statusLine,
        ...(!result.completed && !result.paused && store ? missionReportLines(store, m.mission_id) : []),
      ];
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          missionId: m.mission_id,
          status: m.status,
          paused: result.paused ?? false,
          ...(result.pausedBy ? { pausedBy: result.pausedBy } : {}),
        },
      };
    },
  });

  return [ledgerRead, ledgerClaim, artifactRead, repoSearch, symbol, testsFor, mission, ledgerEvidence];
}
