import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isMachineEvidence, type Actor } from "../core/types.ts";
import { ArtifactStore } from "../artifacts/ArtifactStore.ts";
import { ContextBroker } from "../context/ContextBroker.ts";
import { Ledger } from "../ledger/Ledger.ts";

/** Shared services bound to the current repository's runtime. */
export interface CoreServices {
  ledger: Ledger;
  artifacts: ArtifactStore;
  broker: ContextBroker | null;
  currentWorkItemId: () => string | null;
  actor: () => Actor;
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
export function buildCoreTools(resolve: (cwd: string) => CoreServices | null | Promise<CoreServices | null>): ToolDefinition[] {
  const servicesFor = (cwd: string): Promise<CoreServices | null> => Promise.resolve(resolve(cwd));
  const ledgerRead = defineTool({
    name: "ledger_read",
    label: "Ledger Read",
    description:
      "Query the Engineering Ledger (facts, hypotheses, findings, decisions, requirements, candidates, evidence). Returns compact entity summaries.",
    parameters: Type.Object({
      kind: Type.Optional(
        Type.String({
          description: "Entity kind to filter: fact, hypothesis, finding, decision, requirement, invariant, candidate, evidence",
        }),
      ),
      work_item_id: Type.Optional(Type.String({ description: "Work item to scope the query" })),
      limit: Type.Optional(Type.Number({ description: "Max entities to return" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const services = await servicesFor(ctx.cwd);
      if (!services) return { content: [{ type: "text", text: "Engineering runtime not initialized for this directory." }], details: {} };
      const wi = (params.work_item_id as string | undefined) ?? services.currentWorkItemId();
      let entities = services.ledger.listEntities(undefined, wi ?? undefined);
      if (params.kind) {
        const k = String(params.kind);
        if (k === "candidate" || k === "evidence") {
          const rows = k === "candidate"
            ? services.ledger.listCandidates(wi ?? undefined).map((c) => ({
                id: c.id, work_item_id: c.work_item_id, status: c.status, branch: c.branch,
                base_commit: c.base_commit, evidence_ids: c.evidence_ids, rejection_reason: c.rejection_reason,
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
                    id: e.id, type: e.type, status: e.status, trust: e.trust, exit_code: e.exit_code,
                    summary: e.summary, artifacts: e.artifacts,
                  }));
              })();
          return { content: [{ type: "text", text: JSON.stringify(rows.slice(0, params.limit ?? 20), null, 2) }], details: { rows } };
        }
        entities = entities.filter((e) => e.kind === k);
      }
      const rows = entities.slice(-(params.limit ?? 20)).map((e) => ({
        id: e.id, kind: e.kind, status: e.status, claim: e.claim.slice(0, 200),
        evidence: e.evidence, confidence: e.confidence, severity: e.severity, candidate_id: e.candidate_id,
      }));
      return { content: [{ type: "text", text: JSON.stringify(rows, null, 2) }], details: { rows } };
    },
  });

  const ledgerClaim = defineTool({
    name: "ledger_claim",
    label: "Ledger Claim",
    description:
      "Record an unverified hypothesis or an evidence-backed fact/finding into the Engineering Ledger. Hypotheses are never auto-promoted to facts.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("fact"), Type.Literal("hypothesis"), Type.Literal("finding"), Type.Literal("decision")]),
      claim: Type.String({ description: "The claim text" }),
      evidence: Type.Optional(Type.String({ description: "Evidence reference, or omit if unverified" })),
      severity: Type.Optional(Type.String({ description: "For findings: info, low, medium, high, critical" })),
    }),
    async execute(_id, params, _sig, _onUpdate, ctx) {
      const services = await servicesFor(ctx.cwd);
      if (!services) return { content: [{ type: "text", text: "Engineering runtime not initialized for this directory." }], details: {} };
      const ref = params.evidence ? String(params.evidence) : undefined;
      // A machine-prefixed reference only counts as verified evidence if it
      // actually resolves in the artifact store. A fabricated artifact:// URI
      // must NOT let an agent turn an unverified claim into a verified fact
      // (INV-006). Non-artifact machine refs (test-run://, EVID-) stay trusted
      // only as far as their prefix; the artifact case is the one we can prove.
      let machine = isMachineEvidence(ref);
      if (machine && ref?.startsWith("artifact://") && !services.artifacts.getByUri(ref)) {
        machine = false;
      }
      const status = params.kind === "finding" ? "open" : machine ? "verified" : "open";
      const entity = await services.ledger.recordEntity(
        params.kind as "fact" | "hypothesis" | "finding" | "decision",
        String(params.claim),
        status as never,
        services.actor(),
        services.currentWorkItemId(),
        { evidence: machine ? [String(params.evidence)] : [], severity: params.severity as never },
      );
      return {
        content: [{ type: "text", text: `Recorded ${entity.kind} ${entity.id} (status ${entity.status}).` }],
        details: { id: entity.id, kind: entity.kind, status: entity.status },
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
      if (!services) return { content: [{ type: "text", text: "Engineering runtime not initialized for this directory." }], details: {} };
      const meta = services.artifacts.getByUri(String(params.uri));
      if (!meta) return { content: [{ type: "text", text: "Artifact not found." }], details: { found: false }, isError: true };
      const text = await services.artifacts.readContentByUri(String(params.uri));
      // A missing content file must surface as an error, not a silent empty
      // result (a reviewer would otherwise judge an empty diff and could
      // report no findings, enabling silent promotion).
      if (text == null) {
        return { content: [{ type: "text", text: "Artifact metadata exists but its content file is missing." }], details: { found: false }, isError: true };
      }
      const offset = params.offset ? Math.max(0, Number(params.offset)) : 0;
      const cap = params.max_chars ? Math.max(1, Number(params.max_chars)) : 12000;
      const slice = text.slice(offset, offset + cap);
      const more = offset + cap < text.length;
      const out = more ? `${slice}\n… [truncated; call artifact_read with offset=${offset + cap} to continue]` : slice;
      return { content: [{ type: "text", text: out }], details: { uri: meta.uri, size: meta.size, summary: meta.summary, offset, more } };
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
      if (!services) return { content: [{ type: "text", text: "Engineering runtime not initialized for this directory." }], details: {} };
      if (!services.broker) return { content: [{ type: "text", text: "Not a git repository." }], details: {} };
      const hits = await services.broker.search(String(params.query), params.limit ?? 40);
      const text = hits.length
        ? hits.map((h) => `${h.path}:${h.line} — ${h.text}`).join("\n")
        : "No matches.";
      return { content: [{ type: "text", text }], details: { hits: hits.length } };
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
      if (!services) return { content: [{ type: "text", text: "Engineering runtime not initialized for this directory." }], details: {} };
      if (!services.broker) return { content: [{ type: "text", text: "Not a git repository." }], details: {} };
      const text = await services.broker.readSlice(String(params.path), params.offset ?? 0, params.limit ?? 120);
      if (text === null) return { content: [{ type: "text", text: "File not found." }], details: { found: false }, isError: true };
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
      if (!services) return { content: [{ type: "text", text: "Engineering runtime not initialized for this directory." }], details: {} };
      if (!services.broker) return { content: [{ type: "text", text: "Not a git repository." }], details: {} };
      const tests = await services.broker.testsFor(params.symbols as string[], params.limit ?? 20);
      return { content: [{ type: "text", text: tests.length ? tests.join("\n") : "No relevant tests found." }], details: { tests } };
    },
  });

  return [ledgerRead, ledgerClaim, artifactRead, repoSearch, symbol, testsFor];
}
