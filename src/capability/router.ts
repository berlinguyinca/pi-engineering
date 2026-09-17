/**
 * Capability-aware routing (spec §12).
 *
 * Selection is a fixed pipeline so every decision is explainable:
 * discovery → hard filters → policy → separation of duties → overrides →
 * weighted scoring → selection, with the full candidate set and every rejection
 * retained in the decision record.
 */

import type { EngineeringPolicy, RoutingRoleConfig } from "../lifecycle/policy.ts";
import type {
  CandidateRejection,
  ModelRecord,
  ModelRef,
  RankedCandidate,
  RoutingDecision,
  ScoreBreakdown,
} from "../lifecycle/types.ts";
import { modelKey } from "../lifecycle/types.ts";
import { hasCapability } from "./modelRecord.ts";
import type { ModelCapabilityRegistry } from "./registry.ts";
import { ROLE_REQUIREMENTS, type RoleName } from "./roles.ts";

export interface OverrideLayer {
  source: string;
  /** role -> "provider/id" */
  roles: Record<string, string>;
}

export interface RouteQuery {
  role: RoleName;
  /** The model that produced the work, for separation-of-duties. */
  requester?: ModelRef;
  /** Models to exclude (already tried this round). */
  exclude?: ModelRef[];
  /** Task-level model override (highest precedence). */
  taskOverride?: string;
  /** Extra hard requirements for this specific query. */
  extraRequires?: string[];
  /** Prefer a local model when equally capable. */
  preferLocal?: boolean;
  /** Minimum context window demanded by the assembled prompt. */
  minContext?: number;
}

export interface RouterOptions {
  registry: ModelCapabilityRegistry;
  policy: EngineeringPolicy;
  overrides?: OverrideLayer[];
  /** Session/parent model — never a candidate for independent review. */
  sessionModel?: () => ModelRef | undefined;
}

const TIE_EPSILON = 1e-9;

export class RoleRouter {
  private readonly registry: ModelCapabilityRegistry;
  private readonly policy: EngineeringPolicy;
  private readonly overrides: OverrideLayer[];
  private readonly sessionModel: () => ModelRef | undefined;

  constructor(opts: RouterOptions) {
    this.registry = opts.registry;
    this.policy = opts.policy;
    this.overrides = opts.overrides ?? [];
    this.sessionModel = opts.sessionModel ?? (() => undefined);
  }

  /** Highest-precedence override for a role: task > session > repo > global > provider. */
  resolveOverride(role: RoleName, taskOverride?: string): { ref: string; source: string } | undefined {
    if (taskOverride) return { ref: taskOverride, source: "task" };
    for (const layer of this.overrides) {
      const ref = layer.roles[role];
      if (ref) return { ref, source: layer.source };
    }
    const roleCfg: RoutingRoleConfig | undefined = this.policy.routing.roles[role];
    if (roleCfg?.model) return { ref: roleCfg.model, source: "policy.routing.roles" };
    return undefined;
  }

  private roleConfig(role: RoleName): RoutingRoleConfig {
    return this.policy.routing.roles[role] ?? {};
  }

  /** Score one candidate for one role. Higher is better. */
  score(
    rec: ModelRecord,
    role: RoleName,
    opts: { preferLocal?: boolean; providerRank: Map<string, number> },
  ): ScoreBreakdown {
    const req = ROLE_REQUIREMENTS[role];
    const w = this.policy.routing.scoring;
    const parts: Record<string, number> = {};

    // Capability: how many preferred traits the model actually has.
    const preferred = req.prefers;
    const hits = preferred.filter((t) => hasCapability(rec, t) || rec.tags.includes(t)).length;
    parts.capability = preferred.length ? hits / preferred.length : 0.5;
    if (rec.capabilities.source === "declared") parts.capability += 0.1;

    // Observed performance: only counted once enough samples exist.
    const minSamples = this.policy.routing.observed_min_samples;
    const observed = rec.observed;
    if (this.policy.routing.observed_source !== "off" && observed && observed.samples >= minSamples) {
      const confidence = Math.min(1, 0.5 + observed.samples / (minSamples * 6));
      parts.observed_quality = observed.meanQuality * confidence * this.policy.routing.observed_weight;
      if (observed.failures > observed.samples * 0.3) parts.observed_quality -= 0.3;
    } else {
      // Neutral, not zero: unknown performance must not eliminate a candidate.
      parts.observed_quality = 0.5;
    }

    // Availability / health.
    parts.availability = rec.healthy && rec.available ? 1 : rec.healthy ? 0.4 : 0;
    if (typeof rec.load === "number") parts.availability *= Math.max(0.2, 1 - Math.min(1, rec.load) * 0.6);
    if (typeof rec.queuedJobs === "number" && rec.queuedJobs > 0) {
      parts.availability *= Math.max(0.3, 1 - Math.min(1, rec.queuedJobs / 20));
    }

    // Latency: local + cheap models win; observed latency refines it.
    const latencyProxy = rec.local ? 1 : (rec.priceOutputUsdPerMTok ?? 10) >= 30 ? 0.35 : 0.8;
    const observedLatency = observed?.meanLatencyMs;
    parts.latency =
      typeof observedLatency === "number" ? Math.max(0, Math.min(1, 1 - observedLatency / 120_000)) : latencyProxy;

    // Cost.
    const costPerMTok = (rec.priceInputUsdPerMTok ?? 0) + (rec.priceOutputUsdPerMTok ?? 0);
    parts.cost = costPerMTok <= 0 ? 1 : Math.max(0, Math.min(1, 1 - Math.log10(1 + costPerMTok) / 2.5));

    // Context fit.
    const ctx = rec.contextWindow ?? 0;
    parts.context = ctx === 0 ? 0.4 : Math.min(1, 0.4 + Math.log10(1 + ctx / 8_000) / 2);

    // Diversity: discourage monoculture so separation-of-duties stays satisfiable.
    parts.diversity = 0.5;

    // Local/remote posture.
    const wantsLocal = opts.preferLocal ?? this.policy.vision.prefer_local;
    parts.local_remote = rec.local ? (wantsLocal ? 1 : 0.5) : wantsLocal ? 0.35 : 0.7;

    // Provider preference from policy.
    const rank = opts.providerRank.get(rec.provider);
    if (rank !== undefined) parts.capability += 0.15 * (1 - Math.min(1, rank / 10));

    // Active failure penalty scales the whole score.
    const penalty = rec.penalty ?? 0;
    const total =
      (Object.entries(parts).reduce((sum, [key, value]) => sum + value * (w[key as keyof typeof w] ?? 0), 0) || 0) *
      (1 - penalty);

    return { model: { provider: rec.provider, id: rec.id }, total, parts };
  }

  private providerRankMap(): Map<string, number> {
    const map = new Map<string, number>();
    this.policy.routing.provider_priority.forEach((p, i) => map.set(p, i));
    return map;
  }

  /** Full selection pipeline for one role. Never throws: an empty decision explains itself. */
  async select(query: RouteQuery): Promise<RoutingDecision> {
    const rationale: string[] = [];
    const rejected: CandidateRejection[] = [];
    const req = ROLE_REQUIREMENTS[query.role];
    const cfg = this.roleConfig(query.role);
    const exclude = new Set((query.exclude ?? []).map(modelKey));
    const requires = [...req.requires, ...(cfg.requires ?? []), ...(query.extraRequires ?? [])];
    const minContext = Math.max(query.minContext ?? 0, cfg.min_context ?? 0, req.minContext ?? 0);
    const providerRank = this.providerRankMap();

    const pool = this.registry.all();
    if (pool.length === 0) {
      rationale.push("No models are currently discovered; run /engineering refresh-models.");
      return { role: query.role, candidates: [], rejected, rationale, decidedAt: new Date().toISOString() };
    }

    // 1. Hard filters.
    const survivors: ModelRecord[] = [];
    for (const rec of pool) {
      const ref: ModelRef = { provider: rec.provider, id: rec.id };
      const key = modelKey(ref);
      if (exclude.has(key)) {
        rejected.push({ model: ref, stage: "role_policy", reason: "excluded (already attempted this round)" });
        continue;
      }
      if (!rec.enabled) {
        rejected.push({ model: ref, stage: "disabled", reason: "model is disabled" });
        continue;
      }
      if (!rec.healthy || !rec.available) {
        rejected.push({ model: ref, stage: "health", reason: rec.healthReason ?? "provider unhealthy or unavailable" });
        continue;
      }
      if (this.policy.routing.provider_deny.includes(rec.provider)) {
        rejected.push({ model: ref, stage: "repo_policy", reason: `provider ${rec.provider} is denied by policy` });
        continue;
      }
      const missing = requires.filter((c) => !hasCapability(rec, c));
      if (missing.length) {
        rejected.push({
          model: ref,
          stage: "capability",
          reason: `missing ${missing.join(", ")} (declared: ${
            Object.entries(rec.capabilities.values)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join(", ") || "none"
          })`,
        });
        continue;
      }
      if (minContext > 0 && (rec.contextWindow ?? 0) < minContext) {
        rejected.push({
          model: ref,
          stage: "context",
          reason: `context window ${rec.contextWindow ?? "unknown"} < required ${minContext}`,
        });
        continue;
      }
      survivors.push(rec);
    }

    // 2. Separation of duties.
    const session = this.sessionModel();
    const dutyExcluded = new Set<string>();
    if (this.policy.policies.separation_of_duties.enabled) {
      if (req.independent) {
        if (this.policy.policies.review.reviewer_differs_from_session && session) {
          dutyExcluded.add(modelKey(session));
        }
        if (query.requester) dutyExcluded.add(modelKey(query.requester));
        rationale.push(
          `Separation of duties: ${query.role} must not run on ${[...dutyExcluded].join(", ") || "the requesting model"}.`,
        );
      }
      for (const [a, b] of this.policy.policies.separation_of_duties.distinct) {
        if (a !== query.role && b !== query.role) continue;
        const other = a === query.role ? b : a;
        const otherRef = this.resolveOverride(other as RoleName)?.ref;
        if (otherRef) dutyExcluded.add(otherRef);
        const pinned = cfg.must_differ_from ?? [];
        void pinned;
      }
    }

    const dutyPool = survivors.filter((rec) => {
      const key = `${rec.provider}/${rec.id}`;
      if (dutyExcluded.has(key)) {
        rejected.push({
          model: { provider: rec.provider, id: rec.id },
          stage: "separation_of_duties",
          reason: "reserved for the role that produced this work",
        });
        return false;
      }
      return true;
    });

    if (dutyPool.length === 0 && survivors.length > 0) {
      rationale.push(
        `Every eligible model for ${query.role} is reserved by separation-of-duties; add a second capable model or relax policies.separation_of_duties.`,
      );
    }

    // 3. Scoring.
    const scored: RankedCandidate[] = dutyPool.map((rec) => {
      const s = this.score(rec, query.role, {
        preferLocal: query.preferLocal ?? req.requires.includes("vision"),
        providerRank,
      });
      return { model: s.model, score: s.total, parts: s.parts };
    });
    scored.sort((a, b) => b.score - a.score || modelKey(a.model).localeCompare(modelKey(b.model)));

    // 4. Overrides win over ranking.
    const override = this.resolveOverride(query.role, query.taskOverride);
    let selected: ModelRef | undefined;
    let overrideApplied: RoutingDecision["overrideApplied"];
    if (override) {
      const ref = parseRef(override.ref);
      const inPool = dutyPool.find((rec) => rec.provider === ref.provider && rec.id === ref.id);
      if (inPool) {
        selected = ref;
        overrideApplied = { override: override.ref, source: override.source };
        rationale.push(`Override ${override.ref} applied from ${override.source}.`);
      } else {
        const why = rejected.find((r) => modelKey(r.model) === modelKey(ref));
        rationale.push(
          `Override ${override.ref} requested by ${override.source} is not eligible${why ? `: ${why.reason}` : ": not discovered"}.`,
        );
        if (this.policy.routing.mode === "manual") {
          return {
            role: query.role,
            candidates: scored,
            rejected,
            rationale,
            overrideApplied: { override: override.ref, source: override.source },
            requester: session,
            decidedAt: new Date().toISOString(),
          };
        }
      }
    }
    if (!selected) selected = scored[0]?.model;

    if (selected) {
      const winner = scored.find((c) => modelKey(c.model) === modelKey(selected));
      rationale.push(
        `Selected ${modelKey(selected)}${winner ? ` (score ${winner.score.toFixed(3)})` : ""} for ${query.role} from ${dutyPool.length} eligible model(s).`,
      );
      const runnerUp = scored.find((c) => modelKey(c.model) !== modelKey(selected));
      if (runnerUp && winner && winner.score - runnerUp.score < TIE_EPSILON) {
        rationale.push(`Tie broken by provider/model name ordering against ${modelKey(runnerUp.model)}.`);
      }
    } else {
      rationale.push(`No eligible model for ${query.role}.`);
    }

    return {
      role: query.role,
      selected,
      candidates: scored,
      rejected,
      rationale,
      overrideApplied,
      requester: session,
      decidedAt: new Date().toISOString(),
    };
  }

  /** Next-best model after a failure, excluding everything already attempted. */
  async fallback(query: RouteQuery, attempted: ModelRef[]): Promise<RoutingDecision | undefined> {
    const decision = await this.select({ ...query, exclude: attempted });
    if (!decision.selected) return undefined;
    decision.fallbackOf = attempted[attempted.length - 1];
    decision.rationale.push(`Fallback after ${attempted.map(modelKey).join(", ")} failed.`);
    return decision;
  }
}

export function parseRef(ref: string): ModelRef {
  const slash = ref.indexOf("/");
  if (slash <= 0) return { provider: ref, id: ref };
  return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}
