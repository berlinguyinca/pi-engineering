import { readFileSync } from "node:fs";
/**
 * Roadmap engine facade: load a Roadmap 1.0 definition, generate deterministic
 * evidence, derive milestone states, evaluate the release gate, and produce
 * deterministic check results with exit codes. Used by the `/roadmap-status`
 * command, the `pi-engineering roadmap check` CLI, and the autonomous-stop hook.
 *
 * Completion is derived; the engine never asks an LLM whether the roadmap is
 * complete.
 */
import { access } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { GitRepo } from "../git/GitRepo.ts";
import { GENERATED_TYPES, MANUAL_TYPES, checkFor, requiredTypes, runCheck } from "./checks.ts";
import { type EvidenceFreshness, type FindingsBudget, evaluateAll, milestoneRequiredTypes } from "./evaluate.ts";
import { RoadmapEvidenceStore } from "./evidence.ts";
import { type GateStatusProvider, evaluateReleaseGate } from "./releaseGate.ts";
import { parseRoadmap } from "./schema.ts";
import type {
  EvidenceType,
  MilestoneDef,
  RoadmapCheckResult,
  RoadmapDef,
  RoadmapEvaluation,
  RoadmapEvidence,
} from "./types.ts";

export interface RoadmapEngineOptions {
  repoRoot: string;
  /** Path to the roadmap YAML definition. */
  roadmapPath: string;
  /** Path to the durable evidence JSONL (generated + manual). */
  evidenceFile: string;
  /** Path to the committed manual evidence index (dogfood/fresh_review). */
  manualEvidencePath: string;
  /** Optional store override (used in tests to keep memory-only). */
  store?: RoadmapEvidenceStore;
}

export const ALL_EVIDENCE_TYPES: EvidenceType[] = [...GENERATED_TYPES, ...MANUAL_TYPES];

export class RoadmapEngine {
  readonly repoRoot: string;
  private readonly roadmapPath: string;
  private readonly manualEvidencePath: string;
  store: RoadmapEvidenceStore;
  private gitRepo!: GitRepo;
  private roadmap!: RoadmapDef;
  private readonly lastDeterministic = new Map<string, boolean>();
  private manual: RoadmapEvidence[] = [];

  private constructor(opts: RoadmapEngineOptions) {
    this.repoRoot = opts.repoRoot;
    this.roadmapPath = opts.roadmapPath;
    this.manualEvidencePath = opts.manualEvidencePath;
    this.store = opts.store ?? RoadmapEvidenceStore.inMemory();
  }

  static async open(opts: RoadmapEngineOptions): Promise<RoadmapEngine> {
    const engine = new RoadmapEngine(opts);
    if (!opts.store) {
      engine.store = await RoadmapEvidenceStore.open(opts.evidenceFile);
    }
    const gitRepo = await GitRepo.open(opts.repoRoot);
    if (!gitRepo) throw new RoadmapError(`not inside a git work tree: ${opts.repoRoot}`, 3);
    engine.gitRepo = gitRepo;
    const parsed = engine.parse();
    if (!parsed) throw new RoadmapError("invalid roadmap definition", 2);
    engine.roadmap = parsed;
    await engine.loadManualEvidence();
    return engine;
  }

  private parse(): RoadmapDef | null {
    const yamlText = readFileSync(this.roadmapPath, "utf-8");
    const { roadmap, issues } = parseRoadmap(yamlText, new Set(ALL_EVIDENCE_TYPES));
    if (!roadmap || issues.length) {
      throw new RoadmapError(
        `invalid roadmap definition:\n${issues.map((i) => `  - ${i.path}: ${i.message}`).join("\n")}`,
        2,
      );
    }
    return roadmap;
  }

  get definition(): RoadmapDef {
    return this.roadmap;
  }

  private async loadManualEvidence(): Promise<void> {
    let text: string;
    try {
      text = readFileSync(this.manualEvidencePath, "utf-8");
    } catch {
      this.manual = [];
      return;
    }
    let docs: unknown;
    try {
      docs = parseYaml(text);
    } catch {
      this.manual = [];
      return;
    }
    if (!Array.isArray(docs)) {
      this.manual = [];
      return;
    }
    const out: RoadmapEvidence[] = [];
    for (const d of docs) {
      const r = d as Partial<RoadmapEvidence>;
      if (!r.id || !r.type) continue;
      // Only an explicit "pass" counts as passing; any other value (including
      // "error"/typos) is treated as NOT passing (fail-closed).
      const status = r.status === "pass" ? "pass" : "fail";
      const findingsRaw = r.findings as Partial<{ critical: number; high: number }> | undefined;
      out.push({
        id: r.id,
        milestone: r.milestone ?? "__global__",
        criterionId: r.criterionId,
        type: r.type as EvidenceType,
        status,
        commit: r.commit ?? "",
        generatedAt: r.generatedAt ?? "",
        paths: Array.isArray(r.paths) ? (r.paths as string[]) : [],
        proof: r.proof ?? "",
        source: "manual",
        summary: r.summary,
        findings: findingsRaw
          ? { critical: Number(findingsRaw.critical ?? 0), high: Number(findingsRaw.high ?? 0) }
          : undefined,
      });
    }
    this.manual = out;
    for (const rec of out) await this.store.put(rec);
  }

  /** Deterministic freshness + implementation checks backed by git + fs. */
  private freshness(): EvidenceFreshness {
    return {
      isStale: async (m, record) => {
        const paths = record.paths.length ? record.paths : m.scope.paths;
        return this.gitRepo.changedPathsSince(record.commit, paths);
      },
      implementationExists: async (m) => {
        if (!m.scope.paths.length) return true;
        for (const p of m.scope.paths) {
          const clean = p.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
          try {
            await access(join(this.repoRoot, clean));
            return true;
          } catch {
            // try next path
          }
        }
        return false;
      },
    };
  }

  /**
   * The distinct evidence targets a milestone needs: one per acceptance-criterion
   * evidence ref (criterion-bound) plus one per verification.requires type that no
   * criterion already covers (milestone-level). Each target binds to a concrete
   * evidence record, so acceptance criteria are not satisfied by type alone.
   */
  static evidenceTargets(m: MilestoneDef): Array<{ id: string; criterionId?: string; type: EvidenceType }> {
    const targets: Array<{ id: string; criterionId?: string; type: EvidenceType }> = [];
    const covered = new Set<EvidenceType>();
    for (const c of m.acceptance) {
      for (const ref of c.evidence.required) {
        targets.push({ id: `${m.id}:${c.id}`, criterionId: c.id, type: ref.type });
        covered.add(ref.type);
      }
    }
    for (const t of m.verification.requires) {
      if (covered.has(t)) continue;
      targets.push({ id: `${m.id}:${t}`, type: t });
    }
    return targets;
  }

  /** (Re)generate deterministic evidence at HEAD for every required milestone target. */
  async refreshEvidence(): Promise<void> {
    const types = requiredTypes(this.roadmap.milestones).filter((t) => GENERATED_TYPES.includes(t));
    const commit = await this.gitRepo.headCommit();
    for (const type of types) {
      const check = checkFor(type);
      if (!check) continue;
      const res = await runCheck(check, this.repoRoot);
      this.lastDeterministic.set(type, res.status === "pass");
      // Global gate record.
      await this.store.put({
        id: `__global__:${type}`,
        milestone: "__global__",
        type,
        status: res.status,
        commit,
        generatedAt: new Date().toISOString(),
        paths: check.paths,
        proof: check.command.join(" "),
        source: "generated",
        summary: res.status === "pass" ? "exit 0" : `exit ${res.exitCode}: ${(res.stderr || res.stdout).slice(0, 160)}`,
      });
      // Per-milestone targets (paths scoped to milestone for impact invalidation).
      for (const m of this.roadmap.milestones) {
        for (const target of RoadmapEngine.evidenceTargets(m)) {
          if (target.type !== type) continue;
          await this.store.put({
            id: target.id,
            milestone: m.id,
            criterionId: target.criterionId,
            type,
            status: res.status,
            commit,
            generatedAt: new Date().toISOString(),
            paths: m.scope.paths.length ? m.scope.paths : check.paths,
            proof: check.command.join(" "),
            source: "generated",
            summary:
              res.status === "pass" ? "exit 0" : `exit ${res.exitCode}: ${(res.stderr || res.stdout).slice(0, 160)}`,
          });
        }
      }
    }
  }

  /** Findings provider (default: no unresolved findings beyond manual review records). */
  private findingsProvider(): (id: string) => Promise<FindingsBudget> {
    return async () => ({ critical: 0, high: 0 });
  }

  private gateProvider(): GateStatusProvider {
    return {
      deterministic: async (type) => {
        if (this.lastDeterministic.has(type)) return this.lastDeterministic.get(type) === true;
        const g = this.store.get(`__global__:${type}`);
        return g?.status === "pass";
      },
      freshReview: async () => {
        const rec = this.manual
          .filter((r) => r.type === "fresh_review")
          .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1))[0];
        // Absence of a completed independent review never passes the gate.
        if (!rec) return { critical: 1, high: 1 };
        const fresh =
          (await this.gitRepo.changedPathsSince(rec.commit, rec.paths.length ? rec.paths : ["src", "extensions"]))
            .length === 0;
        if (!fresh || rec.status !== "pass") return { critical: 1, high: 1 };
        return rec.findings ?? { critical: 0, high: 0 };
      },
      dogfood: async () => {
        const rec = this.manual
          .filter((r) => r.type === "dogfood")
          .sort((a, b) => (a.generatedAt < b.generatedAt ? 1 : -1))[0];
        if (!rec || rec.status !== "pass") return false;
        return (
          (await this.gitRepo.changedPathsSince(rec.commit, rec.paths.length ? rec.paths : ["src", "extensions"]))
            .length === 0
        );
      },
    };
  }

  /** Evaluate milestones + release gate from current evidence. */
  async evaluate(): Promise<RoadmapEvaluation> {
    const evals = await evaluateAll(this.roadmap, this.store, this.freshness(), this.findingsProvider());
    const releaseGate = await evaluateReleaseGate(this.roadmap, evals, this.gateProvider());
    const evaluations = [...evals.values()];
    const complete =
      releaseGate.pass &&
      this.roadmap.milestones.filter((m) => m.required).every((m) => evals.get(m.id)?.state === "VERIFIED");
    return {
      roadmapId: this.roadmap.roadmap.id,
      version: this.roadmap.roadmap.version,
      milestones: evaluations,
      releaseGate,
      complete,
    };
  }

  /**
   * Full check: parse → refresh deterministic evidence → evaluate → exit code.
   * 0 complete | 1 valid but not complete | 2 invalid roadmap | 3 infra error.
   */
  async check(opts: { refresh?: boolean } = {}): Promise<RoadmapCheckResult> {
    if (opts.refresh !== false) await this.refreshEvidence();
    const detail = await this.evaluate();
    const required = this.roadmap.milestones.filter((m) => m.required);
    const verified = required.filter(
      (m) => detail.milestones.find((e) => e.milestone.id === m.id)?.state === "VERIFIED",
    ).length;
    const blocking = required
      .filter((m) => detail.milestones.find((e) => e.milestone.id === m.id)?.state !== "VERIFIED")
      .map((m) => m.id);
    const exitCode = detail.complete ? 0 : 1;
    return {
      roadmap: `${detail.roadmapId}@${detail.version}`,
      complete: detail.complete,
      verified,
      required: required.length,
      blockingMilestones: blocking,
      releaseGate: detail.releaseGate.pass ? "PASS" : "FAIL",
      exitCode,
      detail,
    };
  }

  /** Record a manual evidence record (dogfood/fresh_review) into the store + index. */
  async recordManual(rec: Omit<RoadmapEvidence, "source">): Promise<void> {
    await this.store.put({ ...rec, source: "manual" });
  }

  async head(): Promise<string> {
    return this.gitRepo.headCommit();
  }
}

export class RoadmapError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
    this.name = "RoadmapError";
  }
}
