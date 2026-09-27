import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { ExclusiveFileLock } from "../platform/eventstore/fileLock.ts";

const exec = promisify(execFile);

/** Short, stable, filesystem-safe hash of a path for unique worktree dirs. */
function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

export interface WorktreeInfo {
  path: string;
  branch: string;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitMutationGuard {
  assertAuthoritative(): void;
  repositoryIdentity?: { generation: number };
}

export interface PromotionResult {
  promoted: boolean;
  alreadyPromoted?: boolean;
  reason: string | null;
  candidateSha: string | null;
}

export interface CandidateRecord {
  candidateId: string;
  missionId: string;
  repoId: string;
  missionGeneration: number;
  candidateGeneration: number;
  repositoryGeneration: number;
  /** Execution which created this candidate. It never changes across later integration runs. */
  attempt: string;
  parentCandidateId?: string;
  seedSha?: string;
  integrationRunId?: string;
  branch: string;
  path: string;
  baseSha: string;
  candidateSha: string;
  state: "integrating" | "preserved" | "promotion_intent" | "promoted";
  /** Legacy journals are read for backwards compatibility only. */
  merges?: CandidateMergeLifecycle[];
  checks?: CandidateCheckLifecycle[];
  updatedAt: string;
}

/** @deprecated Use CandidateRecord; retained for source compatibility with backend adapters. */
export type CandidateLifecycle = CandidateRecord;

export interface CandidateMergeLifecycle {
  sequence: number;
  ref: string;
  refSha: string;
  beforeSha: string;
  afterSha?: string;
  state: "planned" | "intent" | "abort_intent" | "completed";
  merged?: boolean;
  conflict?: boolean;
  reason?: string | null;
}

export interface IntegrationRunRecord {
  candidateId: string;
  runId: string;
  missionId: string;
  repoId: string;
  missionGeneration: number;
  candidateGeneration: number;
  startingCandidateSha: string;
  candidateSha: string;
  state: "planned" | "running" | "completed" | "preserved";
  merges: CandidateMergeLifecycle[];
  checks: CandidateCheckLifecycle[];
  updatedAt: string;
}

export interface CandidateCheckLifecycle {
  checkId: string;
  state: "intent" | "completed";
  passed?: boolean;
  updatedAt: string;
}

export interface PromotionLifecycle {
  candidateId: string;
  missionId: string;
  repoId: string;
  missionGeneration: number;
  candidateGeneration: number;
  repositoryGeneration: number;
  candidateRepositoryGeneration: number;
  originRepositoryGeneration: number;
  reconciliationRepositoryGeneration?: number;
  attempt: string;
  integrationRunId: string;
  candidateSha: string;
  baseSha: string;
  state: "intent" | "completed";
  updatedAt: string;
}

type PromotionIdentity = Pick<
  CandidateRecord,
  | "missionId"
  | "repoId"
  | "missionGeneration"
  | "candidateGeneration"
  | "repositoryGeneration"
  | "attempt"
  | "baseSha"
  | "candidateSha"
> & { candidateId?: string };

export interface PromotionHooks {
  afterLockAcquired?: () => Promise<void> | void;
  beforeCas?: () => Promise<void> | void;
  afterCas?: () => Promise<void> | void;
  afterReset?: () => Promise<void> | void;
  afterCandidateState?: () => Promise<void> | void;
  afterCompletion?: () => Promise<void> | void;
}

export interface MergeJournalHooks {
  afterMutation?: () => Promise<void> | void;
  afterConflict?: () => Promise<void> | void;
  afterAbortIntent?: () => Promise<void> | void;
  abortMerge?: () => Promise<GitResult>;
}

export interface WorktreeRemovalHooks {
  deleteBranch?: () => Promise<GitResult>;
  afterIntent?: () => Promise<void> | void;
  afterWorktreeRemoved?: () => Promise<void> | void;
  afterBranchDeleted?: () => Promise<void> | void;
}

export interface PendingBranchCleanup {
  missionId: string;
  repoId: string;
  path: string;
  branch: string;
  state: "intent" | "worktree_removed" | "branch_deleted";
  updatedAt: string;
}

export interface PendingBranchCleanupInventory {
  records: PendingBranchCleanup[];
  diagnostics: Array<{ file: string; reason: string }>;
}

export interface DurableRecordInventory<T> {
  records: T[];
  diagnostics: Array<{ file: string; reason: string }>;
}

/**
 * Minimal Git repository provider (spec §7 `git/`, §13.3 worktree isolation).
 *
 * The core runtime talks to git through this small surface. It does not replace
 * git; it wraps the commands the vertical slice needs: repo detection, worktree
 * creation, diff capture, commit, and status.
 */
export class GitRepo {
  private readonly cwd: string;
  private readonly gitArgs: string[];
  private readonly repoRoot: string;

  private constructor(cwd: string, repoRoot: string) {
    this.cwd = cwd;
    this.repoRoot = repoRoot;
    this.gitArgs = ["-C", repoRoot];
  }

  /** Returns a GitRepo if `cwd` is inside a git work tree, else null. */
  static async open(cwd: string): Promise<GitRepo | null> {
    try {
      // Resolve the actual repository toplevel so a caller in a subdirectory
      // (e.g. <repo>/src) still treats the whole repo as its root.
      const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 120_000 });
      if (!stdout.trim()) return null;
      const repo = new GitRepo(cwd, stdout.trim());
      await repo.git(["rev-parse", "--is-inside-work-tree"]);
      return repo;
    } catch {
      return null;
    }
  }

  private async git(args: string[], opts: { timeout?: number; preserveStdout?: boolean } = {}): Promise<GitResult> {
    const timeoutMs = opts.timeout ?? 120_000;
    try {
      const { stdout, stderr } = await exec("git", [...this.gitArgs, ...args], {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { stdout: opts.preserveStdout ? stdout : stdout.trim(), stderr: stderr.trim(), code: 0 };
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string };
      return {
        stdout: opts.preserveStdout ? ((e.stdout as string) ?? "") : ((e.stdout as string) ?? "").trim(),
        stderr: (e.stderr as string) ?? e.message ?? String(e),
        code: typeof e.code === "number" ? e.code : 1,
      };
    }
  }

  get root(): string {
    return this.repoRoot;
  }

  /** Canonical shared object/admin directory, equal across linked worktrees. */
  async commonDir(): Promise<string> {
    const r = await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (r.code !== 0) throw new Error(`git common directory lookup failed: ${r.stderr}`);
    return r.stdout;
  }

  private async candidateStateDir(create = true): Promise<string> {
    const dir = join(await this.commonDir(), "pi-engineering-candidates");
    if (create) await mkdir(dir, { recursive: true });
    return dir;
  }

  private async assertPromotionUnlocked(): Promise<void> {
    const lock = `${join(await this.commonDir(), "pi-engineering-promotion")}.lock`;
    try {
      await access(lock);
      throw new Error("repository promotion critical section is held");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private durableIdentityName(prefix: string, parts: Array<string | number>): string {
    const digest = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
    return `${prefix}.${digest}.json`;
  }

  private candidateStateName(record: CandidateRecord): string {
    return this.durableIdentityName("candidate", [
      record.candidateId,
      record.missionId,
      record.repoId,
      record.missionGeneration,
      record.candidateGeneration,
      record.repositoryGeneration,
      record.attempt,
      record.parentCandidateId ?? "",
      record.seedSha ?? "",
      record.integrationRunId ?? "",
      record.branch,
      record.path,
      record.baseSha,
      record.candidateSha,
    ]);
  }

  private candidateBranch(identity: {
    missionId: string;
    repoId: string;
    missionGeneration: number;
    candidateGeneration: number;
    attempt: string;
  }): string {
    const suffix = [
      identity.missionId,
      identity.repoId,
      identity.missionGeneration,
      identity.candidateGeneration,
      identity.attempt,
    ]
      .join("-")
      .replace(/[^a-zA-Z0-9._-]/g, "-");
    return `pi-eng-candidate-${suffix}`;
  }

  private worktreePath(branch: string): string {
    return join(this.repoRoot, "..", `pi-eng-${shortHash(this.repoRoot)}-${branch}`);
  }

  private candidateId(identity: {
    missionId: string;
    repoId: string;
    missionGeneration: number;
    candidateGeneration: number;
    attempt: string;
  }): string {
    return [
      identity.missionId,
      identity.repoId,
      String(identity.missionGeneration),
      String(identity.candidateGeneration),
      identity.attempt,
    ]
      .map((part) => Buffer.from(part).toString("base64url"))
      .join(".");
  }

  private integrationRunStateName(record: IntegrationRunRecord): string {
    return this.durableIdentityName("run", [
      record.candidateId,
      record.runId,
      record.missionId,
      record.repoId,
      record.missionGeneration,
      record.candidateGeneration,
      record.startingCandidateSha,
      record.candidateSha,
    ]);
  }

  private branchCleanupStateName(
    record: Pick<PendingBranchCleanup, "missionId" | "repoId" | "path" | "branch">,
  ): string {
    return this.durableIdentityName("cleanup", [record.missionId, record.repoId, record.path, record.branch]);
  }

  private async persistPendingBranchCleanup(record: PendingBranchCleanup, guard?: GitMutationGuard): Promise<void> {
    guard?.assertAuthoritative();
    const dir = await this.candidateStateDir();
    const target = join(dir, this.branchCleanupStateName(record));
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    guard?.assertAuthoritative();
    await rename(temporary, target);
  }

  async loadPendingBranchCleanupInventory(missionId: string, repoId: string): Promise<PendingBranchCleanupInventory> {
    const dir = await this.candidateStateDir(false);
    const records: PendingBranchCleanup[] = [];
    const diagnostics: Array<{ file: string; reason: string }> = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith("cleanup.") || !name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as PendingBranchCleanup;
        const structurallyValid =
          typeof parsed.missionId === "string" &&
          parsed.missionId.trim().length > 0 &&
          typeof parsed.repoId === "string" &&
          parsed.repoId.trim().length > 0 &&
          typeof parsed.path === "string" &&
          parsed.path.trim().length > 0 &&
          typeof parsed.branch === "string" &&
          parsed.branch.trim().length > 0 &&
          ["intent", "worktree_removed", "branch_deleted"].includes(parsed.state);
        if (!structurallyValid || name !== this.branchCleanupStateName(parsed)) {
          diagnostics.push({ file: name, reason: "cleanup journal has invalid identity or phase" });
        } else if (parsed.missionId === missionId && parsed.repoId === repoId) {
          records.push(parsed);
        }
      } catch (error) {
        diagnostics.push({
          file: name,
          reason: `cleanup journal is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    return { records, diagnostics };
  }

  async loadPendingBranchCleanups(missionId: string, repoId: string): Promise<PendingBranchCleanup[]> {
    return (await this.loadPendingBranchCleanupInventory(missionId, repoId)).records;
  }

  private promotionStateName(record: PromotionLifecycle): string {
    return this.durableIdentityName("promotion", [
      record.candidateId,
      record.missionId,
      record.repoId,
      record.missionGeneration,
      record.candidateGeneration,
      record.repositoryGeneration,
      record.candidateRepositoryGeneration,
      record.originRepositoryGeneration,
      record.attempt,
      record.integrationRunId,
      record.reconciliationRepositoryGeneration ?? "",
      record.baseSha,
      record.candidateSha,
    ]);
  }

  private async persistPromotionLifecycle(record: PromotionLifecycle, guard?: GitMutationGuard): Promise<void> {
    guard?.assertAuthoritative();
    const dir = await this.candidateStateDir();
    const target = join(dir, this.promotionStateName(record));
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    guard?.assertAuthoritative();
    await rename(temporary, target);
  }

  async persistCandidateLifecycle(record: CandidateLifecycle, guard?: GitMutationGuard): Promise<void> {
    guard?.assertAuthoritative();
    const dir = await this.candidateStateDir();
    const target = join(dir, this.candidateStateName(record));
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    guard?.assertAuthoritative();
    await rename(temporary, target);
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith("candidate.") || !name.endsWith(".json") || join(dir, name) === target) continue;
      try {
        const prior = JSON.parse(await readFile(join(dir, name), "utf8")) as Partial<CandidateLifecycle>;
        if (prior.candidateId === record.candidateId) await rm(join(dir, name), { force: true });
      } catch {
        // Unreadable records remain for inventory diagnostics; never hide corruption.
      }
    }
  }

  async persistIntegrationRun(record: IntegrationRunRecord, guard?: GitMutationGuard): Promise<void> {
    guard?.assertAuthoritative();
    const dir = await this.candidateStateDir();
    const target = join(dir, this.integrationRunStateName(record));
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    guard?.assertAuthoritative();
    await rename(temporary, target);
  }

  async loadCandidateLifecycleInventory(
    missionId: string,
    repoId: string,
  ): Promise<DurableRecordInventory<CandidateLifecycle>> {
    const dir = await this.candidateStateDir(false);
    const records: CandidateLifecycle[] = [];
    const recordFiles = new Map<string, string>();
    const diagnostics: Array<{ file: string; reason: string }> = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      try {
        if (name.startsWith("promotion.") || name.startsWith("run.") || name.startsWith("cleanup.")) continue;
        const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as CandidateLifecycle;
        if (
          typeof parsed.missionId === "string" &&
          parsed.missionId.trim().length > 0 &&
          typeof parsed.repoId === "string" &&
          parsed.repoId.trim().length > 0 &&
          Number.isSafeInteger(parsed.missionGeneration) &&
          parsed.missionGeneration >= 0 &&
          Number.isSafeInteger(parsed.candidateGeneration) &&
          parsed.candidateGeneration >= 0 &&
          Number.isSafeInteger(parsed.repositoryGeneration) &&
          parsed.repositoryGeneration >= 0 &&
          typeof parsed.attempt === "string" &&
          parsed.attempt.trim().length > 0 &&
          typeof parsed.branch === "string" &&
          parsed.branch.trim().length > 0 &&
          typeof parsed.path === "string" &&
          parsed.path.trim().length > 0 &&
          typeof parsed.baseSha === "string" &&
          parsed.baseSha.trim().length > 0 &&
          typeof parsed.candidateSha === "string" &&
          parsed.candidateSha.trim().length > 0 &&
          (parsed.parentCandidateId === undefined ||
            (typeof parsed.parentCandidateId === "string" && parsed.parentCandidateId.trim().length > 0)) &&
          typeof parsed.seedSha === "string" &&
          parsed.seedSha.trim().length > 0 &&
          (parsed.integrationRunId === undefined ||
            (typeof parsed.integrationRunId === "string" && parsed.integrationRunId.trim().length > 0))
        ) {
          const derivedCandidateId = this.candidateId(parsed);
          const canonical = { ...parsed, candidateId: derivedCandidateId };
          const expectedBranch = this.candidateBranch(parsed);
          const expectedPath = this.worktreePath(expectedBranch);
          if (
            parsed.candidateId !== derivedCandidateId ||
            parsed.branch !== expectedBranch ||
            parsed.path !== expectedPath ||
            name !== this.candidateStateName(canonical)
          ) {
            diagnostics.push({ file: name, reason: "candidate identity does not match canonical filename" });
            continue;
          }
          if (parsed.missionId === missionId && parsed.repoId === repoId) {
            records.push(canonical);
            recordFiles.set(canonical.candidateId, name);
          }
        } else {
          diagnostics.push({ file: name, reason: "candidate record has invalid or empty identity fields" });
        }
      } catch (error) {
        diagnostics.push({
          file: name,
          reason: `candidate record is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    const byCandidateId = new Map(records.map((record) => [record.candidateId, record]));
    const runs = await this.loadIntegrationRunInventory(missionId, repoId);
    for (const record of [...records]) {
      const parent = record.parentCandidateId ? byCandidateId.get(record.parentCandidateId) : undefined;
      const lineageValid = record.parentCandidateId
        ? !!parent &&
          parent.missionId === record.missionId &&
          parent.repoId === record.repoId &&
          record.seedSha === parent.candidateSha
        : record.seedSha === record.baseSha;
      const runValid = record.integrationRunId
        ? runs.records.some(
            (run) =>
              run.runId === record.integrationRunId &&
              run.candidateId === record.candidateId &&
              run.missionGeneration === record.missionGeneration &&
              run.candidateGeneration === record.candidateGeneration,
          )
        : true;
      if (!lineageValid || !runValid) {
        diagnostics.push({
          file: recordFiles.get(record.candidateId) ?? "",
          reason: !lineageValid
            ? "candidate parent/seed lineage is invalid"
            : "candidate integration run lineage is invalid",
        });
        records.splice(records.indexOf(record), 1);
      }
    }
    records.sort(
      (a, b) =>
        a.missionGeneration - b.missionGeneration ||
        a.candidateGeneration - b.candidateGeneration ||
        a.updatedAt.localeCompare(b.updatedAt),
    );
    return { records: [...new Map(records.map((record) => [record.candidateId, record])).values()], diagnostics };
  }

  async loadCandidateLifecycles(missionId: string, repoId: string): Promise<CandidateLifecycle[]> {
    return (await this.loadCandidateLifecycleInventory(missionId, repoId)).records;
  }

  async loadIntegrationRunInventory(
    missionId: string,
    repoId: string,
  ): Promise<DurableRecordInventory<IntegrationRunRecord>> {
    const dir = await this.candidateStateDir(false);
    const records: IntegrationRunRecord[] = [];
    const diagnostics: Array<{ file: string; reason: string }> = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith("run.") || !name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as IntegrationRunRecord;
        if (
          typeof parsed.missionId === "string" &&
          parsed.missionId.trim().length > 0 &&
          typeof parsed.repoId === "string" &&
          parsed.repoId.trim().length > 0 &&
          typeof parsed.candidateId === "string" &&
          parsed.candidateId.trim().length > 0 &&
          typeof parsed.runId === "string" &&
          parsed.runId.trim().length > 0 &&
          Number.isSafeInteger(parsed.missionGeneration) &&
          parsed.missionGeneration >= 0 &&
          Number.isSafeInteger(parsed.candidateGeneration) &&
          parsed.candidateGeneration >= 0 &&
          typeof parsed.startingCandidateSha === "string" &&
          parsed.startingCandidateSha.trim().length > 0 &&
          typeof parsed.candidateSha === "string" &&
          parsed.candidateSha.trim().length > 0 &&
          Array.isArray(parsed.merges)
        ) {
          if (name !== this.integrationRunStateName(parsed)) {
            diagnostics.push({ file: name, reason: "integration run identity does not match canonical filename" });
          } else if (parsed.missionId === missionId && parsed.repoId === repoId) records.push(parsed);
        } else {
          diagnostics.push({ file: name, reason: "integration run has invalid or empty identity fields" });
        }
      } catch (error) {
        diagnostics.push({
          file: name,
          reason: `integration run is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    records.sort(
      (a, b) =>
        a.updatedAt.localeCompare(b.updatedAt) || (a.state === "completed" ? 1 : 0) - (b.state === "completed" ? 1 : 0),
    );
    return {
      records: [...new Map(records.map((record) => [`${record.candidateId}\0${record.runId}`, record])).values()],
      diagnostics,
    };
  }

  async loadIntegrationRuns(missionId: string, repoId: string): Promise<IntegrationRunRecord[]> {
    return (await this.loadIntegrationRunInventory(missionId, repoId)).records;
  }

  async beginIntegrationRun(
    candidate: CandidateRecord,
    runId: string,
    refs: string[],
    guard?: GitMutationGuard,
  ): Promise<IntegrationRunRecord> {
    if (candidate.state !== "integrating") {
      throw new Error(`candidate ${candidate.candidateId} is not open for integration (${candidate.state})`);
    }
    const prior = (await this.loadIntegrationRuns(candidate.missionId, candidate.repoId)).find(
      (run) => run.candidateId === candidate.candidateId && run.runId === runId,
    );
    if (prior) return prior;
    const pinned: Array<{ ref: string; refSha: string }> = [];
    for (const ref of refs) {
      const refSha = await this.resolveCommit(ref);
      if (!refSha) throw new Error(`handoff ref is unavailable: ${ref}`);
      pinned.push({ ref, refSha });
    }
    guard?.assertAuthoritative();
    const record: IntegrationRunRecord = {
      candidateId: candidate.candidateId,
      runId,
      missionId: candidate.missionId,
      repoId: candidate.repoId,
      missionGeneration: candidate.missionGeneration,
      candidateGeneration: candidate.candidateGeneration,
      startingCandidateSha: candidate.candidateSha,
      candidateSha: candidate.candidateSha,
      state: "planned",
      merges: pinned.map(({ ref, refSha }, sequence) => ({
        sequence,
        ref,
        refSha,
        beforeSha: sequence === 0 ? candidate.candidateSha : "",
        state: "planned",
      })),
      checks: [],
      updatedAt: new Date().toISOString(),
    };
    await this.persistIntegrationRun(record, guard);
    return record;
  }

  async loadPromotionLifecycleInventory(
    missionId: string,
    repoId: string,
  ): Promise<DurableRecordInventory<PromotionLifecycle>> {
    const dir = await this.candidateStateDir(false);
    const records: PromotionLifecycle[] = [];
    const diagnostics: Array<{ file: string; reason: string }> = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith("promotion.") || !name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as PromotionLifecycle;
        if (
          typeof parsed.missionId === "string" &&
          parsed.missionId.trim().length > 0 &&
          typeof parsed.repoId === "string" &&
          parsed.repoId.trim().length > 0 &&
          Number.isSafeInteger(parsed.missionGeneration) &&
          parsed.missionGeneration >= 0 &&
          Number.isSafeInteger(parsed.candidateGeneration) &&
          parsed.candidateGeneration >= 0 &&
          Number.isSafeInteger(parsed.repositoryGeneration) &&
          parsed.repositoryGeneration >= 0 &&
          Number.isSafeInteger(parsed.candidateRepositoryGeneration) &&
          parsed.candidateRepositoryGeneration >= 0 &&
          Number.isSafeInteger(parsed.originRepositoryGeneration) &&
          parsed.originRepositoryGeneration >= 0 &&
          typeof parsed.attempt === "string" &&
          parsed.attempt.trim().length > 0 &&
          typeof parsed.integrationRunId === "string" &&
          parsed.integrationRunId.trim().length > 0 &&
          typeof parsed.baseSha === "string" &&
          parsed.baseSha.trim().length > 0 &&
          typeof parsed.candidateSha === "string" &&
          parsed.candidateSha.trim().length > 0 &&
          parsed.repositoryGeneration === parsed.originRepositoryGeneration &&
          parsed.candidateRepositoryGeneration <= parsed.originRepositoryGeneration &&
          (parsed.reconciliationRepositoryGeneration === undefined ||
            (Number.isSafeInteger(parsed.reconciliationRepositoryGeneration) &&
              parsed.reconciliationRepositoryGeneration >= 0 &&
              parsed.reconciliationRepositoryGeneration >= parsed.originRepositoryGeneration)) &&
          (parsed.state !== "intent" || parsed.reconciliationRepositoryGeneration === undefined) &&
          (parsed.state !== "completed" || parsed.reconciliationRepositoryGeneration !== undefined) &&
          (parsed.state === "intent" || parsed.state === "completed")
        ) {
          const derivedCandidateId = this.candidateId(parsed);
          if (parsed.candidateId !== derivedCandidateId) {
            diagnostics.push({ file: name, reason: "promotion candidate identity is not canonical" });
          } else if (name !== this.promotionStateName(parsed)) {
            diagnostics.push({ file: name, reason: "promotion identity does not match canonical filename" });
          } else if (parsed.missionId === missionId && parsed.repoId === repoId) records.push(parsed);
        } else {
          diagnostics.push({
            file: name,
            reason:
              "promotion authority ordering is invalid: candidate repository generation must not exceed origin or reconciliation generation",
          });
        }
      } catch (error) {
        diagnostics.push({
          file: name,
          reason: `promotion record is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    records.sort(
      (a, b) =>
        a.updatedAt.localeCompare(b.updatedAt) || (a.state === "completed" ? 1 : 0) - (b.state === "completed" ? 1 : 0),
    );
    return { records, diagnostics };
  }

  async loadPromotionLifecycles(missionId: string, repoId: string): Promise<PromotionLifecycle[]> {
    return (await this.loadPromotionLifecycleInventory(missionId, repoId)).records;
  }

  async createCandidateWorktree(
    baseSha: string,
    identity: {
      missionId: string;
      repoId: string;
      missionGeneration: number;
      candidateGeneration: number;
      repositoryGeneration: number;
      attempt: string;
      parentCandidateId?: string;
      seedSha?: string;
    },
    guard?: GitMutationGuard,
  ): Promise<CandidateLifecycle> {
    const existing = (await this.loadCandidateLifecycles(identity.missionId, identity.repoId)).find(
      (record) =>
        record.missionGeneration === identity.missionGeneration &&
        record.candidateGeneration === identity.candidateGeneration &&
        record.attempt === identity.attempt,
    );
    if (existing) {
      if (existing.state !== "integrating" && existing.state !== "promotion_intent") {
        throw new Error(`${existing.state} candidate attempt already exists at ${existing.branch}`);
      }
      const reconciled = await this.reconcileCandidateWorktree(existing, guard);
      if (reconciled) return existing;
      throw new Error(`candidate attempt already exists but cannot be reconciled: ${existing.branch}`);
    }
    const seedSha = identity.seedSha ?? baseSha;
    const worktree = await this.createWorktree(seedSha, this.candidateBranch(identity), guard);
    const record: CandidateLifecycle = {
      ...identity,
      candidateId: this.candidateId(identity),
      ...worktree,
      baseSha,
      seedSha,
      candidateSha: await this.headCommitIn(worktree.path),
      state: "integrating",
      updatedAt: new Date().toISOString(),
    };
    await this.persistCandidateLifecycle(record, guard);
    return record;
  }

  /** Re-open the exact persisted candidate, mounting its worktree if a crash removed only the checkout. */
  async reconcileCandidateWorktree(record: CandidateLifecycle, guard?: GitMutationGuard): Promise<WorktreeInfo | null> {
    const ref = await this.resolveCommit(record.branch);
    if (ref !== record.candidateSha) {
      const runs = (await this.loadIntegrationRuns(record.missionId, record.repoId)).filter(
        (run) => run.candidateId === record.candidateId,
      );
      const proof = runs.find(
        (run) =>
          run.candidateSha === ref ||
          run.merges.some(
            (merge) =>
              merge.state !== "completed" &&
              merge.beforeSha === record.candidateSha &&
              ref !== null &&
              merge.refSha.length > 0,
          ),
      );
      if (!ref || !proof) return null;
      const pending = proof.merges.find(
        (merge) => merge.state !== "completed" && merge.beforeSha === record.candidateSha,
      );
      if (pending && !(await this.isAncestor(pending.refSha, ref))) return null;
      if (pending) {
        proof.merges = proof.merges.map((merge) =>
          merge.sequence === pending.sequence
            ? { ...merge, state: "completed", merged: true, conflict: false, reason: null, afterSha: ref! }
            : merge,
        );
      }
      proof.candidateSha = ref;
      proof.updatedAt = new Date().toISOString();
      await this.persistIntegrationRun(proof, guard);
      record.candidateSha = ref;
      record.updatedAt = proof.updatedAt;
      await this.persistCandidateLifecycle(record, guard);
    }
    const mountedHead = await this.headCommitIn(record.path).catch(() => null);
    if (mountedHead === record.candidateSha) return { path: record.path, branch: record.branch };
    if (mountedHead !== null) return null;
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    const add = await this.git(["worktree", "add", record.path, record.branch]);
    if (add.code !== 0) return null;
    guard?.assertAuthoritative();
    return (await this.headCommitIn(record.path)) === record.candidateSha
      ? { path: record.path, branch: record.branch }
      : null;
  }

  async beginCandidateCheck(
    lifecycle: CandidateLifecycle,
    checkId: string,
    guard?: GitMutationGuard,
    run?: IntegrationRunRecord,
  ): Promise<void> {
    const checks = run?.checks ?? lifecycle.checks ?? [];
    const prior = checks.find((check) => check.checkId === checkId);
    if (prior?.state === "completed") return;
    const intent: CandidateCheckLifecycle = { checkId, state: "intent", updatedAt: new Date().toISOString() };
    if (run) {
      run.checks = [...run.checks.filter((check) => check.checkId !== checkId), intent];
      run.updatedAt = intent.updatedAt;
      await this.persistIntegrationRun(run, guard);
    } else {
      lifecycle.checks = [...checks.filter((check) => check.checkId !== checkId), intent];
    }
    lifecycle.updatedAt = intent.updatedAt;
    await this.persistCandidateLifecycle(lifecycle, guard);
  }

  async completeCandidateCheck(
    lifecycle: CandidateLifecycle,
    checkId: string,
    passed: boolean,
    guard?: GitMutationGuard,
    run?: IntegrationRunRecord,
  ): Promise<void> {
    const completed: CandidateCheckLifecycle = {
      checkId,
      state: "completed",
      passed,
      updatedAt: new Date().toISOString(),
    };
    if (run) {
      run.checks = [...run.checks.filter((check) => check.checkId !== checkId), completed];
      run.state = passed ? "completed" : "preserved";
      run.updatedAt = completed.updatedAt;
      await this.persistIntegrationRun(run, guard);
    } else {
      lifecycle.checks = [...(lifecycle.checks ?? []).filter((check) => check.checkId !== checkId), completed];
    }
    lifecycle.updatedAt = completed.updatedAt;
    await this.persistCandidateLifecycle(lifecycle, guard);
  }

  async headCommit(): Promise<string> {
    const r = await this.git(["rev-parse", "HEAD"]);
    if (r.code !== 0) throw new Error(`git rev-parse HEAD failed: ${r.stderr}`);
    return r.stdout;
  }

  /** Resolve a ref only when this repository owns the referenced commit. */
  async resolveCommit(ref: string): Promise<string | null> {
    const r = await this.git(["rev-parse", "--verify", `${ref}^{commit}`]);
    return r.code === 0 && r.stdout ? r.stdout : null;
  }

  /** Resolve HEAD commit inside a specific worktree path. */
  async headCommitIn(path: string): Promise<string> {
    const r = await this.git(["-C", path, "rev-parse", "HEAD"]);
    if (r.code !== 0) throw new Error(`git rev-parse HEAD in ${path} failed: ${r.stderr}`);
    return r.stdout;
  }

  async currentBranch(): Promise<string | null> {
    const r = await this.git(["branch", "--show-current"]);
    return r.code === 0 && r.stdout ? r.stdout : null;
  }

  async isClean(): Promise<boolean> {
    const r = await this.git(["status", "--porcelain"]);
    return r.code === 0 && r.stdout.length === 0;
  }

  async status(): Promise<string> {
    const r = await this.git(["status", "--short"]);
    return r.stdout;
  }

  /** Working-tree status inside a specific path (e.g. a candidate worktree). */
  async statusIn(path: string): Promise<string> {
    const r = await this.git(["-C", path, "status", "--short"]);
    return r.stdout;
  }

  /**
   * Create an isolated worktree on a new branch at the given base commit.
   * (INV-004 candidate isolation.)
   *
   * The worktree path is derived from the repo root so that multiple repos (or
   * parallel test fixtures) never collide. A stale leftover at the path is
   * removed first (crash recovery).
   */
  async createWorktree(baseCommit: string, branch: string, guard?: GitMutationGuard): Promise<WorktreeInfo> {
    await this.assertPromotionUnlocked();
    // Place the worktree as a SIBLING of the repo root (outside the working
    // tree). Deriving the path from `this.cwd` would, when the runtime is
    // opened from a subdirectory, drop the worktree INSIDE the repo (visible
    // as an untracked dir in the main tree). repoRoot is stable regardless of
    // where the runtime was opened.
    const parent = join(this.repoRoot, "..");
    const path = join(parent, `pi-eng-${shortHash(this.repoRoot)}-${branch}`);
    await mkdir(parent, { recursive: true }).catch(() => {});
    // Crash recovery: clear any stale worktree or leftover directory at the path.
    guard?.assertAuthoritative();
    await this.git(["worktree", "remove", "--force", path]).catch(() => {});
    guard?.assertAuthoritative();
    await this.git(["branch", "-D", branch]).catch(() => {});
    guard?.assertAuthoritative();
    await this.forgetWorktreeAdmin(path);
    guard?.assertAuthoritative();
    await rm(path, { recursive: true, force: true }).catch(() => {});
    guard?.assertAuthoritative();
    const add = await this.git(["worktree", "add", path, "-b", branch, baseCommit]);
    if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr}`);
    return { path, branch };
  }

  /**
   * Drop the administrative directory for ONE worktree path, if it is stale.
   *
   * This replaces `git worktree prune`, which is global: it removes the
   * administrative directory of every worktree whose working directory is
   * currently missing, including ones created moments ago — the
   * `gc.worktreePruneExpire` default does not protect them (checked against the
   * installed git). Since candidate isolation creates worktrees in parallel,
   * and `git worktree add` has a window where the administrative directory
   * exists before the working directory does, a prune issued by one creation
   * could delete a sibling's and leave it unusable
   * ("fatal: not a git repository: .../worktrees/<name>").
   *
   * Locking around the prune fixed that and cost the parallelism it was
   * protecting — candidates stopped overlapping at all. Removing only this
   * path's entry needs no lock, because every caller owns a distinct path.
   */
  private async forgetWorktreeAdmin(path: string): Promise<void> {
    const common = await this.git(["rev-parse", "--git-common-dir"]);
    if (common.code !== 0) return;
    const gitDir = common.stdout.trim();
    if (!gitDir) return;
    const absolute = gitDir.startsWith("/") ? gitDir : join(this.repoRoot, gitDir);
    // `git worktree add` names the administrative directory after the leaf of
    // the worktree path.
    await rm(join(absolute, "worktrees", basename(path)), { recursive: true, force: true }).catch(() => {});
  }

  /** Remove a worktree (cleanup/recovery). Optionally keep the branch for lineage. */
  async removeWorktree(
    info: WorktreeInfo,
    opts: { keepBranch?: boolean; cleanupIdentity?: { missionId: string; repoId: string } } = {},
    guard?: GitMutationGuard,
    hooks: WorktreeRemovalHooks = {},
  ): Promise<void> {
    await this.assertPromotionUnlocked();
    let pending: PendingBranchCleanup | undefined;
    if (!opts.keepBranch && opts.cleanupIdentity) {
      const inventory = await this.loadPendingBranchCleanupInventory(
        opts.cleanupIdentity.missionId,
        opts.cleanupIdentity.repoId,
      );
      if (inventory.diagnostics.length > 0) {
        throw new Error(
          `cleanup journal identity is corrupt; refusing Git mutation: ${inventory.diagnostics
            .map((diagnostic) => `${diagnostic.file}: ${diagnostic.reason}`)
            .join("; ")}`,
        );
      }
      pending = inventory.records.find((record) => record.branch === info.branch && record.path === info.path);
      const expectedJournal = join(
        await this.candidateStateDir(false),
        this.branchCleanupStateName({ ...opts.cleanupIdentity, path: info.path, branch: info.branch }),
      );
      if (!pending) {
        try {
          await access(expectedJournal);
          throw new Error("cleanup journal canonical filename does not match its payload identity");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (inventory.records.length > 0 && !pending) {
        throw new Error("cleanup ownership does not match the requested repository worktree path and branch");
      }
      if (!pending) {
        pending = {
          ...opts.cleanupIdentity,
          path: info.path,
          branch: info.branch,
          state: "intent",
          updatedAt: new Date().toISOString(),
        };
        await this.persistPendingBranchCleanup(pending, guard);
        await hooks.afterIntent?.();
      }
    }
    if (!pending || pending.state === "intent") {
      let worktreeExists = true;
      try {
        await access(info.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") worktreeExists = false;
        else throw error;
      }
      if (worktreeExists) {
        const listed = await this.git(["worktree", "list", "--porcelain"], { preserveStdout: true });
        if (listed.code !== 0) throw new Error(`cleanup ownership lookup failed: ${listed.stderr}`);
        const expectedBranch = `refs/heads/${info.branch}`;
        const exactMapping = listed.stdout
          .split(/\n\n+/)
          .some(
            (entry) =>
              entry.split("\n").includes(`worktree ${info.path}`) &&
              entry.split("\n").includes(`branch ${expectedBranch}`),
          );
        if (!exactMapping) {
          throw new Error("cleanup ownership does not match an exact repository worktree path and branch mapping");
        }
        guard?.assertAuthoritative();
        const removed = await this.git(["worktree", "remove", "--force", info.path]);
        if (removed.code !== 0) {
          throw new Error(`git worktree remove failed for ${info.path}: ${removed.stderr || removed.stdout}`);
        }
      }
      // Targeted, for the same reason creation is: a global prune here would
      // be able to delete a concurrently-created sibling's administration.
      guard?.assertAuthoritative();
      await this.forgetWorktreeAdmin(info.path);
      if (pending) {
        pending = { ...pending, state: "worktree_removed", updatedAt: new Date().toISOString() };
        await this.persistPendingBranchCleanup(pending, guard);
        await hooks.afterWorktreeRemoved?.();
      }
    }
    if (!opts.keepBranch && (!pending || pending.state === "worktree_removed")) {
      const branchExists = (await this.resolveCommit(info.branch)) !== null;
      if (branchExists) {
        guard?.assertAuthoritative();
        const deleted = hooks.deleteBranch ? await hooks.deleteBranch() : await this.git(["branch", "-D", info.branch]);
        if (deleted.code !== 0) {
          throw new Error(`git branch delete failed for ${info.branch}: ${deleted.stderr || deleted.stdout}`);
        }
      }
      if (pending) {
        pending = { ...pending, state: "branch_deleted", updatedAt: new Date().toISOString() };
        await this.persistPendingBranchCleanup(pending, guard);
        await hooks.afterBranchDeleted?.();
      }
    }
    if (pending?.state === "branch_deleted") {
      guard?.assertAuthoritative();
      await rm(join(await this.candidateStateDir(), this.branchCleanupStateName(pending)), { force: true });
    }
  }

  /**
   * The most recent commits, newest first.
   *
   * Uses a unit-separator between fields rather than a printable delimiter,
   * because commit subjects routinely contain every punctuation character a
   * naive split would choke on.
   */
  async recentCommits(limit = 5): Promise<Array<{ sha: string; subject: string; relative: string }>> {
    const r = await this.git(["--no-pager", "log", `-n${Math.max(1, limit)}`, "--format=%h%x1f%s%x1f%cr"]);
    if (r.code !== 0) return [];
    const out: Array<{ sha: string; subject: string; relative: string }> = [];
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [sha, subject, relative] = line.split("\x1f");
      if (!sha || !subject) continue;
      out.push({ sha, subject, relative: relative ?? "" });
    }
    return out;
  }

  /**
   * The patch a commit introduced.
   *
   * `--format=` drops the header so the result is a PURE diff: the panel's
   * gutter numbers diff hunks and colours `+`/`-` lines, and a `commit …` /
   * `Author: …` preamble would be numbered as source line 1. The subject
   * belongs in the view's title, not in its body.
   *
   * `--first-parent` is what makes this work on a merge, which by default shows
   * no patch at all — an empty pane where the operator asked to see a change.
   */
  async commitDiff(sha: string): Promise<string> {
    const r = await this.git(["--no-pager", "show", "--format=", "--patch", "--first-parent", sha]);
    if (r.code !== 0) return "";
    return r.stdout;
  }

  /**
   * Per-file added/removed line counts for the working tree.
   *
   * `--numstat` rather than parsing a diff: it is one line per file, and it
   * reports `-` for binary files instead of a count, which is a distinction the
   * panel should show rather than render as zero.
   */
  async diffStats(): Promise<Map<string, { added: number; removed: number; binary: boolean }>> {
    const out = new Map<string, { added: number; removed: number; binary: boolean }>();
    const r = await this.git(["--no-pager", "diff", "--numstat", "HEAD"]);
    if (r.code !== 0) return out;
    for (const line of r.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [added, removed, ...rest] = line.split("\t");
      const path = rest.join("\t");
      if (!path) continue;
      const binary = added === "-" || removed === "-";
      out.set(path, {
        added: binary ? 0 : Number.parseInt(added ?? "0", 10) || 0,
        removed: binary ? 0 : Number.parseInt(removed ?? "0", 10) || 0,
        binary,
      });
    }
    return out;
  }

  async deleteBranch(branch: string, guard?: GitMutationGuard): Promise<void> {
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    await this.git(["branch", "-D", branch]).catch(() => {});
  }

  /**
   * Controlled promotion: merge a verified candidate branch into the incumbent
   * (current) branch and update the working tree. The worker never writes to the
   * incumbent directly (INV-003); this is the runtime's evidence-gated merge.
   * Returns false (without mutating state) if the merge would conflict.
   */
  async mergeBranch(
    branch: string,
    guard?: GitMutationGuard,
  ): Promise<{ merged: boolean; conflict: boolean; reason: string | null }> {
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    const r = await this.git(["--no-pager", "merge", "--no-ff", "-m", `promote ${branch}`, branch]);
    if (r.code === 0) return { merged: true, conflict: false, reason: null };
    const conflicted = r.stdout.includes("CONFLICT") || r.stderr.includes("CONFLICT");
    const reason = (r.stderr || r.stdout || "merge failed").split("\n")[0]?.slice(0, 200) ?? "merge failed";
    if (conflicted) {
      // Keep the incumbent immutable: abort the merge.
      guard?.assertAuthoritative();
      await this.git(["merge", "--abort"]).catch(() => {});
    }
    return { merged: false, conflict: conflicted, reason };
  }

  /** Merge one handoff into an isolated integration candidate, never the incumbent checkout. */
  async mergeRefInWorktree(
    candidate: WorktreeInfo,
    ref: string,
    guard?: GitMutationGuard,
    lifecycle?: CandidateLifecycle,
    sequence?: number,
    hooks: MergeJournalHooks = {},
    run?: IntegrationRunRecord,
  ): Promise<{ merged: boolean; conflict: boolean; reason: string | null }> {
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    let journal =
      run && sequence !== undefined
        ? run.merges.find((entry) => entry.sequence === sequence)
        : lifecycle && sequence !== undefined
          ? lifecycle.merges?.find((entry) => entry.sequence === sequence)
          : undefined;
    const refSha = journal?.refSha ?? (await this.resolveCommit(ref));
    if (!refSha) return { merged: false, conflict: false, reason: `handoff ref is unavailable: ${ref}` };
    const beforeSha = await this.headCommitIn(candidate.path);
    if (journal && (journal.ref !== ref || journal.refSha !== refSha)) {
      throw new Error(`candidate merge journal identity mismatch at sequence ${sequence}`);
    }
    const persistJournal = async (entry: CandidateMergeLifecycle, candidateSha: string): Promise<void> => {
      const now = new Date().toISOString();
      if (run) {
        run.merges = run.merges.map((item) => (item.sequence === entry.sequence ? entry : item));
        run.candidateSha = candidateSha;
        run.state = "running";
        run.updatedAt = now;
        await this.persistIntegrationRun(run, guard);
      } else if (lifecycle && sequence !== undefined) {
        lifecycle.merges = [...(lifecycle.merges ?? []).filter((item) => item.sequence !== sequence), entry];
      }
      if (lifecycle) {
        lifecycle.candidateSha = candidateSha;
        lifecycle.updatedAt = now;
        await this.persistCandidateLifecycle(lifecycle, guard);
      }
    };
    const mergeState = async (): Promise<{ mergeHead: boolean; unmerged: boolean; dirty: boolean }> => {
      const [mergeHead, unmerged, status] = await Promise.all([
        this.git(["-C", candidate.path, "rev-parse", "-q", "--verify", "MERGE_HEAD"]),
        this.git(["-C", candidate.path, "diff", "--name-only", "--diff-filter=U"]),
        this.git(["-C", candidate.path, "status", "--porcelain", "--untracked-files=all"]),
      ]);
      return {
        mergeHead: mergeHead.code === 0 && mergeHead.stdout.length > 0,
        unmerged: unmerged.stdout.length > 0,
        dirty: status.stdout.length > 0,
      };
    };
    const abortConflict = async (entry: CandidateMergeLifecycle, reason: string) => {
      const abortIntent: CandidateMergeLifecycle = { ...entry, state: "abort_intent", conflict: true, reason };
      await persistJournal(abortIntent, entry.beforeSha);
      await hooks.afterAbortIntent?.();
      guard?.assertAuthoritative();
      const aborted = hooks.abortMerge
        ? await hooks.abortMerge()
        : await this.git(["-C", candidate.path, "merge", "--abort"]);
      if (aborted.code !== 0) throw new Error(`candidate conflict abort failed: ${aborted.stderr || aborted.stdout}`);
      const current = await this.headCommitIn(candidate.path);
      const state = await mergeState();
      if (current !== entry.beforeSha || state.mergeHead || state.unmerged || state.dirty) {
        throw new Error(`candidate conflict abort did not restore clean HEAD ${entry.beforeSha}`);
      }
      const completed: CandidateMergeLifecycle = {
        ...abortIntent,
        state: "completed",
        merged: false,
        conflict: true,
        reason,
        afterSha: current,
      };
      await persistJournal(completed, current);
      return { merged: false, conflict: true, reason };
    };
    if (journal?.state === "completed") {
      const current = await this.headCommitIn(candidate.path);
      if (journal.afterSha && (await this.isAncestor(journal.afterSha, current))) {
        return {
          merged: journal.merged === true,
          conflict: journal.conflict === true,
          reason: journal.reason ?? null,
        };
      }
      throw new Error(`candidate merge journal result is not present at HEAD for sequence ${sequence}`);
    }
    if (journal?.state === "abort_intent") {
      const state = await mergeState();
      if (!state.mergeHead && !state.unmerged && !state.dirty && beforeSha === journal.beforeSha) {
        const completed = {
          ...journal,
          state: "completed" as const,
          merged: false,
          conflict: true,
          afterSha: beforeSha,
        };
        await persistJournal(completed, beforeSha);
        return { merged: false, conflict: true, reason: journal.reason ?? "merge conflict" };
      }
      return abortConflict(journal, journal.reason ?? "merge conflict");
    }
    if (journal?.state === "intent") {
      const current = await this.headCommitIn(candidate.path);
      if (current !== journal.beforeSha && (await this.isAncestor(journal.refSha, current))) {
        journal = { ...journal, state: "completed", merged: true, conflict: false, reason: null, afterSha: current };
        await persistJournal(journal, current);
        return { merged: true, conflict: false, reason: null };
      }
      if (current !== journal.beforeSha) {
        throw new Error(`candidate HEAD cannot reconcile merge intent at sequence ${sequence}`);
      }
      const state = await mergeState();
      if (state.mergeHead || state.unmerged) {
        return abortConflict(journal, journal.reason ?? "merge conflict recovered from interrupted merge");
      }
      if (state.dirty) throw new Error(`candidate merge intent has unexpected dirty worktree at sequence ${sequence}`);
    } else if ((lifecycle || run) && sequence !== undefined) {
      journal = { sequence, ref, refSha, beforeSha, state: "intent" };
      await persistJournal(journal, beforeSha);
    } else if (journal?.state === "planned") {
      journal = { ...journal, beforeSha, state: "intent" };
      await persistJournal(journal, beforeSha);
    }
    guard?.assertAuthoritative();
    const r = await this.git([
      "-C",
      candidate.path,
      "--no-pager",
      "merge",
      "--no-ff",
      "-m",
      `integrate ${ref}`,
      refSha,
    ]);
    if (r.code === 0) {
      await hooks.afterMutation?.();
      const afterSha = await this.headCommitIn(candidate.path);
      if ((lifecycle || run) && journal && sequence !== undefined) {
        const completed: CandidateMergeLifecycle = {
          ...journal,
          state: "completed",
          merged: true,
          conflict: false,
          reason: null,
          afterSha,
        };
        await persistJournal(completed, afterSha);
      }
      return { merged: true, conflict: false, reason: null };
    }
    const conflicted = r.stdout.includes("CONFLICT") || r.stderr.includes("CONFLICT");
    const reason = (r.stderr || r.stdout || "merge failed").split("\n")[0]?.slice(0, 200) ?? "merge failed";
    if (conflicted) {
      await hooks.afterConflict?.();
      if (journal) return abortConflict(journal, reason);
      guard?.assertAuthoritative();
      const aborted = await this.git(["-C", candidate.path, "merge", "--abort"]);
      if (aborted.code !== 0) throw new Error(`candidate conflict abort failed: ${aborted.stderr || aborted.stdout}`);
    }
    if ((lifecycle || run) && journal && sequence !== undefined) {
      const afterSha = await this.headCommitIn(candidate.path);
      const completed: CandidateMergeLifecycle = {
        ...journal,
        state: "completed",
        merged: false,
        conflict: conflicted,
        reason,
        afterSha,
      };
      await persistJournal(completed, afterSha);
    }
    return { merged: false, conflict: conflicted, reason };
  }

  /**
   * Promote a fully gated candidate into the local incumbent checkout.
   * The bound base is checked immediately before the single reset mutation;
   * divergence leaves HEAD, index, and tree unchanged.
   */
  async promoteCandidate(
    candidate: WorktreeInfo,
    boundBase: string,
    guard?: GitMutationGuard,
    lifecycle?: CandidateLifecycle,
    hooks: PromotionHooks = {},
  ): Promise<PromotionResult> {
    guard?.assertAuthoritative();
    const lockFile = join(await this.commonDir(), "pi-engineering-promotion");
    let lock: ExclusiveFileLock;
    let promotionIntent: PromotionLifecycle | undefined;
    try {
      lock = await ExclusiveFileLock.acquire(lockFile);
    } catch (error) {
      return {
        promoted: false,
        reason: `repository promotion critical section is already held: ${error instanceof Error ? error.message : String(error)}`,
        candidateSha: null,
      };
    }
    try {
      await hooks.afterLockAcquired?.();
      const candidateSha = await this.resolveCommit(candidate.branch);
      if (!candidateSha) return { promoted: false, reason: "candidate ref is unavailable", candidateSha: null };
      const incumbent = await this.headCommit();
      if (incumbent === candidateSha) {
        if (!lifecycle) {
          return { promoted: false, reason: "exact durable promotion intent is required", candidateSha };
        }
        return await this.reconcilePromotionLocked(
          {
            candidateId: lifecycle.candidateId,
            missionId: lifecycle.missionId,
            repoId: lifecycle.repoId,
            missionGeneration: lifecycle.missionGeneration,
            candidateGeneration: lifecycle.candidateGeneration,
            repositoryGeneration: guard?.repositoryIdentity?.generation ?? lifecycle.repositoryGeneration,
            attempt: lifecycle.attempt,
            baseSha: boundBase,
            candidateSha,
          },
          guard,
          lifecycle,
          hooks,
        );
      }
      if ((await this.statusIn(candidate.path)) !== "") {
        return { promoted: false, reason: "candidate worktree is not clean", candidateSha };
      }
      if (incumbent !== boundBase) {
        return { promoted: false, reason: `incumbent diverged from bound base ${boundBase}`, candidateSha };
      }
      const candidateRuntimePaths = (await this.changedFiles(boundBase, candidateSha)).filter(
        (path) => path === ".pi-eng" || path.startsWith(".pi-eng/"),
      );
      if (candidateRuntimePaths.length > 0) {
        return {
          promoted: false,
          reason: `candidate collides with runtime-owned state: ${candidateRuntimePaths.join(", ")}`,
          candidateSha,
        };
      }
      const incumbentStatus = await this.git(["status", "--porcelain", "--untracked-files=all"]);
      const incumbentDirt = incumbentStatus.stdout
        .split("\n")
        .filter((line) => line.length > 0 && !line.startsWith("?? .pi-eng/"))
        .join("\n");
      if (incumbentStatus.code !== 0 || incumbentDirt.length > 0) {
        return {
          promoted: false,
          reason: `incumbent index or working tree is not clean: ${incumbentDirt || incumbentStatus.stderr}`,
          candidateSha,
        };
      }
      guard?.assertAuthoritative();
      if (lifecycle) {
        const originRepositoryGeneration = guard?.repositoryIdentity?.generation ?? lifecycle.repositoryGeneration;
        promotionIntent = {
          candidateId: lifecycle.candidateId,
          missionId: lifecycle.missionId,
          repoId: lifecycle.repoId,
          missionGeneration: lifecycle.missionGeneration,
          candidateGeneration: lifecycle.candidateGeneration,
          repositoryGeneration: originRepositoryGeneration,
          candidateRepositoryGeneration: lifecycle.repositoryGeneration,
          originRepositoryGeneration,
          attempt: lifecycle.attempt,
          integrationRunId: lifecycle.integrationRunId ?? "direct-promotion",
          candidateSha,
          baseSha: boundBase,
          state: "intent",
          updatedAt: new Date().toISOString(),
        };
        await this.persistPromotionLifecycle(promotionIntent, guard);
        await this.persistCandidateLifecycle(
          { ...lifecycle, candidateSha, state: "promotion_intent", updatedAt: new Date().toISOString() },
          guard,
        );
      }
      // Repository authority serializes local promotion. Recheck at the mutation
      // boundary so a stale or diverged incumbent is rejected without a write.
      if ((await this.headCommit()) !== boundBase) {
        return { promoted: false, reason: `incumbent diverged from bound base ${boundBase}`, candidateSha };
      }
      await hooks.beforeCas?.();
      guard?.assertAuthoritative();
      const advanced = await this.git(["update-ref", "HEAD", candidateSha, boundBase]);
      if (advanced.code !== 0) {
        return {
          promoted: false,
          reason: advanced.stderr || advanced.stdout || "promotion compare-and-swap failed",
          candidateSha,
        };
      }
      await hooks.afterCas?.();
      // From this point promotion is committed. Complete checkout reconciliation
      // even if the lease expires during the subprocess; restart follows the same
      // HEAD==candidate path above.
      const promoted = await this.git(["reset", "--hard", candidateSha]);
      if (promoted.code !== 0) {
        return {
          promoted: false,
          reason: `promotion committed; checkout reconciliation failed: ${promoted.stderr}`,
          candidateSha,
        };
      }
      await hooks.afterReset?.();
      if (lifecycle) {
        // Once HEAD moved, authority loss is reconciled as a committed promotion,
        // never reported as an ordinary rejection that callers might retry.
        const promotedLifecycle: CandidateLifecycle = {
          ...lifecycle,
          candidateSha,
          state: "promoted",
          updatedAt: new Date().toISOString(),
        };
        await this.persistCandidateLifecycle(promotedLifecycle);
        Object.assign(lifecycle, promotedLifecycle);
        await hooks.afterCandidateState?.();
        await this.persistPromotionLifecycle({
          ...promotionIntent!,
          reconciliationRepositoryGeneration: promotionIntent!.originRepositoryGeneration,
          state: "completed",
          updatedAt: new Date().toISOString(),
        });
        await hooks.afterCompletion?.();
      }
      return { promoted: true, reason: null, candidateSha };
    } finally {
      lock.release();
    }
  }

  async reconcilePromotion(identity: PromotionIdentity, guard?: GitMutationGuard): Promise<PromotionResult> {
    guard?.assertAuthoritative();
    const lockFile = join(await this.commonDir(), "pi-engineering-promotion");
    let lock: ExclusiveFileLock;
    try {
      lock = await ExclusiveFileLock.acquire(lockFile);
    } catch (error) {
      return {
        promoted: false,
        reason: `repository promotion critical section is already held: ${error instanceof Error ? error.message : String(error)}`,
        candidateSha: identity.candidateSha,
      };
    }
    try {
      const lifecycle = (await this.loadCandidateLifecycles(identity.missionId, identity.repoId)).find(
        (record) =>
          record.candidateId === (identity.candidateId ?? this.candidateId(identity)) &&
          record.missionGeneration === identity.missionGeneration &&
          record.candidateGeneration === identity.candidateGeneration &&
          record.attempt === identity.attempt &&
          record.baseSha === identity.baseSha &&
          record.candidateSha === identity.candidateSha,
      );
      return await this.reconcilePromotionLocked(identity, guard, lifecycle);
    } finally {
      lock.release();
    }
  }

  /**
   * Recover only promotion side effects already committed by an exact durable
   * intent. The caller supplies fresh authority; the intent retains the
   * historical authority identity which originated the CAS.
   */
  async reconcileCommittedPromotions(
    missionId: string,
    repoId: string,
    guard: GitMutationGuard,
  ): Promise<PromotionResult[]> {
    guard.assertAuthoritative();
    const intents = (await this.loadPromotionLifecycles(missionId, repoId)).filter(
      (record) => record.state === "intent",
    );
    if (intents.length === 0) return [];
    const incumbent = await this.headCommit();
    const committed = intents.find((intent) => intent.candidateSha === incumbent);
    if (committed) return [await this.reconcilePromotion(committed, guard)];
    return intents.map((intent) => {
      if (incumbent === intent.baseSha) {
        return {
          promoted: false,
          reason: "durable promotion intent has no committed compare-and-swap",
          candidateSha: intent.candidateSha,
        };
      }
      return {
        promoted: false,
        reason: `incumbent diverged from durable promotion intent (${incumbent})`,
        candidateSha: intent.candidateSha,
      };
    });
  }

  private async reconcilePromotionLocked(
    identity: PromotionIdentity,
    guard?: GitMutationGuard,
    lifecycle?: CandidateLifecycle,
    hooks: PromotionHooks = {},
  ): Promise<PromotionResult> {
    if (!lifecycle) {
      return {
        promoted: false,
        reason: "exact durable candidate lifecycle is required for promotion reconciliation",
        candidateSha: identity.candidateSha,
      };
    }
    const intent = (await this.loadPromotionLifecycles(identity.missionId, identity.repoId)).find(
      (record) =>
        record.candidateId === lifecycle.candidateId &&
        record.missionId === lifecycle.missionId &&
        record.repoId === lifecycle.repoId &&
        record.missionGeneration === lifecycle.missionGeneration &&
        record.candidateGeneration === lifecycle.candidateGeneration &&
        record.candidateRepositoryGeneration === lifecycle.repositoryGeneration &&
        record.attempt === lifecycle.attempt &&
        record.integrationRunId === (lifecycle.integrationRunId ?? "direct-promotion") &&
        record.baseSha === lifecycle.baseSha &&
        record.candidateSha === lifecycle.candidateSha &&
        (record.state === "intent" || record.state === "completed"),
    );
    if (!intent) {
      return {
        promoted: false,
        reason: "exact durable promotion intent is required for already-promoted reconciliation",
        candidateSha: identity.candidateSha,
      };
    }
    if ((await this.headCommit()) !== identity.candidateSha) {
      return {
        promoted: false,
        reason: "durable promotion intent does not match incumbent HEAD",
        candidateSha: identity.candidateSha,
      };
    }
    guard?.assertAuthoritative();
    const reconciled = await this.git(["reset", "--hard", identity.candidateSha]);
    if (reconciled.code !== 0) {
      throw new Error(`promotion committed; checkout reconciliation failed: ${reconciled.stderr}`);
    }
    await hooks.afterReset?.();
    if (lifecycle) {
      const promotedLifecycle: CandidateLifecycle = {
        ...lifecycle,
        candidateSha: identity.candidateSha,
        state: "promoted",
        updatedAt: new Date().toISOString(),
      };
      await this.persistCandidateLifecycle(promotedLifecycle);
      Object.assign(lifecycle, promotedLifecycle);
      await hooks.afterCandidateState?.();
    }
    await this.persistPromotionLifecycle({
      ...intent,
      reconciliationRepositoryGeneration:
        guard?.repositoryIdentity?.generation ??
        intent.reconciliationRepositoryGeneration ??
        intent.originRepositoryGeneration,
      state: "completed",
      updatedAt: new Date().toISOString(),
    });
    await hooks.afterCompletion?.();
    return { promoted: true, alreadyPromoted: true, reason: null, candidateSha: identity.candidateSha };
  }

  async commitAll(path: string, message: string, guard?: GitMutationGuard): Promise<void> {
    await this.assertPromotionUnlocked();
    guard?.assertAuthoritative();
    await this.git(["-C", path, "add", "-A"]);
    guard?.assertAuthoritative();
    const r = await this.git(["-C", path, "commit", "-m", message]);
    if (r.code !== 0) throw new Error(`git commit failed: ${r.stderr}`);
  }

  /**
   * Number of commits in `range` (e.g. "HEAD..branch") — i.e. committed work
   * on the branch that the incumbent has not yet received. null when git
   * cannot answer (bad ref, git failure): "unknown" is not "no commits", and
   * the caller decides how to surface it.
   */
  async revListCount(range: string): Promise<number | null> {
    const r = await this.git(["--no-pager", "rev-list", "--count", range]);
    if (r.code !== 0) return null;
    const n = Number.parseInt(r.stdout.trim(), 10);
    return Number.isFinite(n) ? n : null;
  }

  /** Unified diff between two commits (or base and worktree HEAD). */
  async captureDiff(baseCommit: string, headCommit: string): Promise<string> {
    const r = await this.git(["diff", baseCommit, headCommit, "--", ":!package-lock.json"]);
    return r.stdout;
  }

  async changedFiles(baseCommit: string, headCommit: string): Promise<string[]> {
    const r = await this.git(["diff", "--no-renames", "--name-only", "-z", baseCommit, headCommit], {
      preserveStdout: true,
    });
    return r.stdout ? r.stdout.split("\0").filter(Boolean) : [];
  }

  /** NUL-safe working-tree paths, including both endpoints of renames/copies. */
  async statusPathsIn(path: string): Promise<string[]> {
    const r = await this.git(["-C", path, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      preserveStdout: true,
    });
    if (r.code !== 0 || !r.stdout) return [];
    const records = r.stdout.split("\0");
    const paths: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const status = record.slice(0, 2);
      const destination = record.slice(3);
      if (destination) paths.push(destination);
      if (status.includes("R") || status.includes("C")) {
        const source = records[++i];
        if (source) paths.push(source);
      }
    }
    return paths;
  }

  /**
   * Files under `paths` that changed since `commit` (committed AND uncommitted).
   * Used for impact-based roadmap-evidence invalidation (spec §10): conservative,
   * path-scoped, and model-free. `paths` may be git pathspecs (globs). An empty
   * `paths` matches everything.
   */
  async changedPathsSince(commit: string, paths: string[]): Promise<string[]> {
    // Fail-safe: an empty/placeholder/unknown commit is never "fresh". Evidence
    // MUST bind to a real commit SHA (roadmap spec §9); on any git error we treat
    // the scope as changed (stale) rather than silently fresh.
    if (!commit) return paths.length ? [...paths] : ["<unbound-evidence>"];
    const spec = paths.length ? ["--", ...paths] : [];
    const committed = await this.git(["diff", "--name-only", `${commit}..HEAD`, ...spec]);
    const uncommitted = await this.git(["status", "--porcelain", ...spec]);
    if (committed.code !== 0 || uncommitted.code !== 0) {
      return paths.length ? [...paths] : ["<git-error>"];
    }
    const set = new Set<string>();
    // git diff --name-only prints bare filenames.
    if (committed.stdout) {
      for (const line of committed.stdout.split("\n")) {
        const f = line.trim();
        if (f) set.add(f);
      }
    }
    // git status --porcelain prefixes each line with "XY " (2 status chars + space).
    if (uncommitted.stdout) {
      for (const line of uncommitted.stdout.split("\n")) {
        if (!line.trim()) continue;
        const file = line.slice(3).trim();
        if (file) set.add(file);
      }
    }
    return [...set];
  }

  /**
   * True when `branch` carries commits since `baseCommit` (i.e. its tip is not
   * the base commit). This is how a worker's OWN commits are recognized: an
   * implementer that commits directly onto its worker branch leaves a clean
   * working tree, but the branch has advanced past base — the work HAS landed
   * there. Returns false when the branch cannot be resolved or has no commits
   * beyond base.
   */
  async branchAheadOf(baseCommit: string, branch: string): Promise<boolean> {
    const r = await this.git(["rev-list", "--count", `${baseCommit}..${branch}`]);
    if (r.code !== 0) return false;
    const n = Number.parseInt(r.stdout, 10);
    return Number.isFinite(n) && n > 0;
  }

  /**
   * True when `commit` is an ancestor of `ancestorOf` (reachable from it).
   *
   * Used to decide whether a worker branch's work is already contained in the
   * integrated checkout before a cleanup is allowed to force-delete the branch.
   * A branch whose tip is NOT an ancestor of HEAD still carries unmerged work
   * and must be preserved; returning false on any git error makes cleanup err on
   * the safe side (preserve rather than destroy).
   */
  async isAncestor(commit: string, ancestorOf: string): Promise<boolean> {
    const r = await this.git(["merge-base", "--is-ancestor", commit, ancestorOf]);
    return r.code === 0;
  }
}
