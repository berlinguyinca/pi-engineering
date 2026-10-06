import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { access, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
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

export class GitQueryError extends Error {
  readonly code = "GIT_QUERY_FAILED";
  readonly operation: string;
  readonly args: readonly string[];
  readonly exitCode: number;

  constructor(operation: string, args: readonly string[], exitCode: number, stderr: string) {
    super(`git ${operation} failed (exit ${exitCode}): ${stderr || "no diagnostic output"}`);
    this.name = "GitQueryError";
    this.operation = operation;
    this.args = args;
    this.exitCode = exitCode;
  }
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

  private requireQuery(result: GitResult, operation: string, args: readonly string[]): GitResult {
    if (result.code !== 0) throw new GitQueryError(operation, args, result.code, result.stderr || result.stdout);
    return result;
  }

  /**
   * `git` with a payload on stdin (plumbing commands that read content: hash-object,
   * mktree, commit-tree). execFile has no `input` option, so this spawns and writes
   * stdin for real, with a kill timeout and GitResult mapping matching git().
   */
  private gitWithStdin(args: string[], input: string, env: NodeJS.ProcessEnv, timeoutMs = 120_000): Promise<GitResult> {
    return new Promise((done) => {
      const child = spawn("git", [...this.gitArgs, ...args], { env, timeout: timeoutMs, stdio: "pipe" });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let spawnError: Error | undefined;
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      // A git that exits early (bad args) closes stdin; the exit code reports it.
      child.stdin.on("error", () => {});
      child.on("error", (err) => {
        spawnError = err;
      });
      child.on("close", (code, signal) => {
        const err = Buffer.concat(stderr).toString("utf8").trim();
        const failure = spawnError?.message ?? (signal ? `killed by ${signal} (timeout ${timeoutMs}ms)` : "");
        done({
          stdout: Buffer.concat(stdout).toString("utf8").trim(),
          stderr: [err, failure].filter(Boolean).join("\n"),
          code: code ?? 1,
        });
      });
      child.stdin.end(input);
    });
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
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
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
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    guard?.assertAuthoritative();
    await rename(temporary, target);
  }

  async persistCandidateLifecycle(record: CandidateLifecycle, guard?: GitMutationGuard): Promise<void> {
    guard?.assertAuthoritative();
    const dir = await this.candidateStateDir();
    const target = join(dir, this.candidateStateName(record));
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
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
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
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
        if (
          name.startsWith("promotion.") ||
          name.startsWith("run.") ||
          name.startsWith("cleanup.") ||
          name.startsWith("nestedpub.")
        )
          continue;
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
    const args = ["rev-parse", "--verify", `${ref}^{commit}`];
    const r = await this.git(args);
    if (r.code === 0 && r.stdout) return r.stdout;
    if (
      /needed a single revision|unknown revision|ambiguous argument|not a valid object name|bad revision/i.test(
        r.stderr,
      )
    ) {
      return null;
    }
    throw new GitQueryError("commit resolution query", args, r.code, r.stderr || r.stdout);
  }

  /** Resolve HEAD commit inside a specific worktree path. */
  async headCommitIn(path: string): Promise<string> {
    const r = await this.git(["-C", path, "rev-parse", "HEAD"]);
    if (r.code !== 0) throw new Error(`git rev-parse HEAD in ${path} failed: ${r.stderr}`);
    return r.stdout;
  }

  async currentBranch(): Promise<string | null> {
    const args = ["branch", "--show-current"];
    const r = this.requireQuery(await this.git(args), "current branch query", args);
    return r.stdout || null;
  }

  /**
   * True when the repository has an `origin` remote — the precondition for
   * cross-host coordination (lane refs live on the shared origin).
   */
  async hasRemoteOrigin(): Promise<boolean> {
    const result = await this.git(["remote", "get-url", "origin"]);
    return result.code === 0 && result.stdout.length > 0;
  }

  /**
   * Read the content of a lane ref from the shared origin. Returns null when the
   * ref does not exist. The sha is the remote object id, which doubles as the
   * compare-and-swap token for casPushRef.
   */
  async readRemoteRef(ref: string): Promise<{ sha: string; content: string } | null> {
    const lsArgs = ["ls-remote", "origin", ref];
    const listing = this.requireQuery(await this.git(lsArgs), "readRemoteRef", lsArgs);
    if (listing.stdout.length === 0) return null;
    const tempRef = `refs/pieng-lane-tmp/${process.pid}-${randomUUID()}`;
    try {
      const fetchArgs = ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "origin", `+${ref}:${tempRef}`];
      this.requireQuery(await this.git(fetchArgs), "readRemoteRef", fetchArgs);
      const shaArgs = ["rev-parse", "--verify", tempRef];
      const sha = this.requireQuery(await this.git(shaArgs), "readRemoteRef", shaArgs).stdout;
      const showArgs = ["show", `${tempRef}:lanes.json`];
      const shown = this.requireQuery(await this.git(showArgs, { preserveStdout: true }), "readRemoteRef", showArgs);
      return { sha, content: shown.stdout };
    } finally {
      await this.git(["update-ref", "-d", tempRef]);
    }
  }

  /**
   * Compare-and-swap a lane ref on the shared origin to a new single-file payload.
   * The payload is wrapped in an orphan commit (fixed identity — lane refs are
   * machine metadata, not authorship). `expectedSha` must equal the sha last
   * observed via readRemoteRef (null = "must still be absent"). A lost race is NOT
   * an error: the call resolves with ok:false and the current remote sha so the
   * caller can re-read and retry.
   */
  async casPushRef(
    ref: string,
    content: string,
    expectedSha: string | null,
  ): Promise<{ ok: boolean; remoteSha: string | null }> {
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "pi-engineering",
      GIT_AUTHOR_EMAIL: "lanes@pi-engineering.local",
      GIT_COMMITTER_NAME: "pi-engineering",
      GIT_COMMITTER_EMAIL: "lanes@pi-engineering.local",
    };
    const blobArgs = ["hash-object", "-w", "--stdin"];
    const blob = this.requireQuery(await this.gitWithStdin(blobArgs, content, env), "casPushRef", blobArgs);
    const treeArgs = ["mktree"];
    const tree = this.requireQuery(
      await this.gitWithStdin(treeArgs, `100644 blob ${blob.stdout}\tlanes.json\n`, env),
      "casPushRef",
      treeArgs,
    );
    const commitArgs = ["commit-tree", tree.stdout, "-m", "pi-eng lane index"];
    const commitSha = this.requireQuery(await this.gitWithStdin(commitArgs, "", env), "casPushRef", commitArgs).stdout;
    // An empty lease value means "the remote ref must not exist".
    const pushArgs = [
      "push",
      "--quiet",
      `--force-with-lease=${ref}:${expectedSha ?? ""}`,
      "origin",
      `${commitSha}:${ref}`,
    ];
    const pushed = await this.git(pushArgs);
    if (pushed.code === 0) return { ok: true, remoteSha: commitSha };
    const lsArgs = ["ls-remote", "origin", ref];
    const current = this.requireQuery(await this.git(lsArgs), "casPushRef", lsArgs);
    const remoteSha = current.stdout.length > 0 ? (current.stdout.split(/\s+/)[0] ?? null) : null;
    if (remoteSha === expectedSha) {
      throw new GitQueryError("casPushRef", pushArgs, pushed.code, pushed.stderr || pushed.stdout);
    }
    return { ok: false, remoteSha };
  }

  async isClean(): Promise<boolean> {
    const r = await this.git(["status", "--porcelain"]);
    return r.code === 0 && r.stdout.length === 0;
  }

  /** Noncritical panel-only best effort; safety decisions use the checked query methods below. */
  async status(): Promise<string> {
    const r = await this.git(["status", "--short"]);
    return r.stdout;
  }

  /** Working-tree status inside a specific path (e.g. a candidate worktree). */
  async statusIn(path: string): Promise<string> {
    const args = ["-C", path, "status", "--short"];
    const r = this.requireQuery(await this.git(args), `status query in ${path}`, args);
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
    await this.linkSharedNodeModules(path);
    return { path, branch };
  }

  /**
   * Link the repo root's `node_modules` into a freshly created worktree.
   *
   * Worktrees are created as SIBLINGS of the repo root, so the verifier's
   * walk-up from the worktree cwd never reaches the repo root's
   * `node_modules` and bare binaries (`tsc`, `biome`, `tsx`, ...) are not
   * found — every deterministic check (the integration verifier, recovery)
   * fails with "tsc: not found". Symlinking the shared `node_modules`
   * (rather than reinstalling) is the documented convention (AGENTS.md) and
   * keeps the dependency cache singular. No-op when the repo declares no
   * `node_modules` or the worktree already has one. Best-effort: a link
   * failure never breaks worktree creation (git operations don't need it).
   */
  private async linkSharedNodeModules(worktreePath: string): Promise<void> {
    const source = join(this.repoRoot, "node_modules");
    try {
      await access(source);
    } catch {
      return; // no node_modules at the repo root; nothing to share
    }
    const target = join(worktreePath, "node_modules");
    try {
      await lstat(target);
      return; // already present (a real dir from a prior provisioning)
    } catch {
      // absent: create the symlink below
    }
    let linkTarget = source;
    try {
      // Point at the real directory so a symlinked repo node_modules does not
      // produce a chain of symlinks in the worktree.
      linkTarget = await realpath(source);
    } catch {
      // keep the plain path if realpath fails
    }
    try {
      await symlink(linkTarget, target);
    } catch (err) {
      void err; // best-effort provisioning; never break worktree creation
    }
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
  /** Noncritical panel-only best effort; an unavailable history renders as no rows. */
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
  /** Noncritical panel-only best effort; failure renders an empty preview. */
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
  /** Noncritical panel-only best effort; failure renders no statistics. */
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
    const args = ["diff", baseCommit, headCommit, "--", ":!package-lock.json"];
    const r = this.requireQuery(await this.git(args), "candidate diff capture", args);
    return r.stdout;
  }

  async changedFiles(baseCommit: string, headCommit: string): Promise<string[]> {
    const args = ["diff", "--no-renames", "--name-only", "-z", baseCommit, headCommit];
    const r = this.requireQuery(
      await this.git(args, {
        preserveStdout: true,
      }),
      "changed-file query",
      args,
    );
    return r.stdout ? r.stdout.split("\0").filter(Boolean) : [];
  }

  /** NUL-safe working-tree paths, including both endpoints of renames/copies. */
  async statusPathsIn(path: string): Promise<string[]> {
    const args = ["-C", path, "status", "--porcelain=v1", "-z", "--untracked-files=all"];
    const r = this.requireQuery(
      await this.git(args, {
        preserveStdout: true,
      }),
      `changed working-tree path query in ${path}`,
      args,
    );
    if (!r.stdout) return [];
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
    const args = ["rev-list", "--count", `${baseCommit}..${branch}`];
    const r = this.requireQuery(await this.git(args), "branch handoff query", args);
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
    const args = ["merge-base", "--is-ancestor", commit, ancestorOf];
    const r = await this.git(args);
    if (r.code === 0) return true;
    if (r.code === 1) return false;
    throw new GitQueryError("ancestry safety query", args, r.code, r.stderr || r.stdout);
  } // ─────────────────────────────────────────────────────────────────────────
  // Nested standalone repository publication (defect-4)
  //
  // A mission anchors to the repository it started in, but workers may
  // legitimately publish work to standalone git repositories nested inside the
  // anchored working tree (e.g. a private product repo inside a meta-root).
  // Those nested repos are not candidates of the anchored repo: no worktree,
  // no branch, no merge. The pipeline observes a nested HEAD advancing over
  // the execution window and records a durable "nested repo publication" as
  // candidate evidence in the same candidate store.
  // ─────────────────────────────────────────────────────────────────────────

  /** Directories that never contain a nested standalone repo worth scanning. */
  private static readonly NESTED_SCAN_SKIP_DIRS = new Set([
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    "vendor",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
    ".turbo",
    ".gradle",
    "coverage",
  ]);

  /** Bounded scan depth: nested repos deeper than this are not discovered. */
  private static readonly NESTED_SCAN_DEFAULT_MAX_DEPTH = 4;

  /** Git command against an arbitrary checkout (nested repo), same error shape as `git`. */
  private async gitIn(
    dir: string,
    args: string[],
    opts: { timeout?: number; preserveStdout?: boolean } = {},
  ): Promise<GitResult> {
    const timeoutMs = opts.timeout ?? 120_000;
    try {
      const { stdout, stderr } = await exec("git", ["-C", dir, ...args], {
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

  private async nestedRepoHead(absolutePath: string): Promise<string | null> {
    const r = await this.gitIn(absolutePath, ["rev-parse", "HEAD"]);
    return r.code === 0 && r.stdout ? r.stdout : null;
  }

  private async nestedRepoBranch(absolutePath: string): Promise<string | null> {
    const r = await this.gitIn(absolutePath, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    return r.code === 0 && r.stdout ? r.stdout : null;
  }

  /** `origin`, else the first configured remote, else null (no remote). */
  private async nestedRepoRemoteUrl(absolutePath: string): Promise<string | null> {
    const origin = await this.gitIn(absolutePath, ["remote", "get-url", "origin"]);
    if (origin.code === 0 && origin.stdout) return origin.stdout;
    const remotes = await this.gitIn(absolutePath, ["remote"]);
    if (remotes.code !== 0 || !remotes.stdout) return null;
    const first = remotes.stdout
      .split("\n")
      .map((name) => name.trim())
      .find((name) => name.length > 0);
    if (!first) return null;
    const url = await this.gitIn(absolutePath, ["remote", "get-url", first]);
    return url.code === 0 && url.stdout ? url.stdout : null;
  }

  private async nestedRepoPublishedSha(
    absolutePath: string,
    remoteUrl: string,
    branch: string,
  ): Promise<string | null> {
    const r = await this.gitIn(absolutePath, ["ls-remote", remoteUrl, branch], { timeout: 30_000 });
    if (r.code !== 0) return null;
    const line = r.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry.length > 0);
    if (!line) return null;
    const sha = line.split(/\s+/)[0] ?? "";
    return /^[0-9a-f]{7,40}$/i.test(sha) ? sha : null;
  }

  private async nestedRepoDiffStat(absolutePath: string, baseSha: string, headSha: string): Promise<string> {
    const r = await this.gitIn(absolutePath, ["diff", "--stat", `${baseSha}..${headSha}`], { preserveStdout: true });
    return r.code === 0 ? r.stdout.trim() : "";
  }

  /**
   * True when `absolute` is a standalone git repository (has a `.git` file or
   * dir) that is NOT a worktree of this anchored repo. Worktrees are excluded
   * via the anchored `git worktree list` and by comparing the candidate's
   * git-common-dir against the anchored repo's common dir.
   */
  private async isNestedStandaloneRepo(
    absolute: string,
    anchoredWorktreePaths: ReadonlySet<string>,
    anchoredCommonDir: string,
  ): Promise<boolean> {
    try {
      const dotGit = await lstat(join(absolute, ".git"));
      if (!dotGit.isFile() && !dotGit.isDirectory()) return false;
    } catch {
      return false;
    }
    if (anchoredWorktreePaths.has(resolve(absolute))) return false;
    const common = await this.gitIn(absolute, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common.code !== 0) return false;
    return resolve(common.stdout) !== anchoredCommonDir;
  }

  /**
   * Discover nested standalone git repositories in the anchored working tree.
   * Bounded depth; skips `.git` internals, dependency/build dirs; excludes
   * worktrees of the anchored repo itself.
   */
  async discoverNestedRepos(
    maxDepth: number = GitRepo.NESTED_SCAN_DEFAULT_MAX_DEPTH,
  ): Promise<Array<{ nestedPath: string; absolutePath: string }>> {
    const refs: Array<{ nestedPath: string; absolutePath: string }> = [];
    const worktreePaths = new Set<string>();
    const listing = await this.git(["worktree", "list", "--porcelain"]);
    if (listing.code === 0) {
      for (const line of listing.stdout.split("\n")) {
        if (line.startsWith("worktree ")) worktreePaths.add(resolve(line.slice("worktree ".length).trim()));
      }
    }
    const anchoredCommonDir = resolve(await this.commonDir());
    const visit = async (dir: string, rel: string, depth: number): Promise<void> => {
      const entries: Dirent[] = await readdir(dir, { withFileTypes: true }).catch(() => [] as Dirent[]);
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        // Directories only: never follow symlinks (bounded, loop-safe scan).
        if (!entry.isDirectory()) continue;
        if (GitRepo.NESTED_SCAN_SKIP_DIRS.has(entry.name)) continue;
        const absolutePath = join(dir, entry.name);
        const nestedPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (depth <= maxDepth && (await this.isNestedStandaloneRepo(absolutePath, worktreePaths, anchoredCommonDir))) {
          refs.push({ nestedPath, absolutePath });
          continue; // never descend into a discovered nested repo
        }
        if (depth < maxDepth) await visit(absolutePath, nestedPath, depth + 1);
      }
    };
    await visit(this.repoRoot, "", 1);
    refs.sort((a, b) => a.nestedPath.localeCompare(b.nestedPath));
    return refs;
  }

  /** Nested HEADs (nestedPath -> sha) for repos with a commit at HEAD. */
  async captureNestedRepoHeads(maxDepth: number = GitRepo.NESTED_SCAN_DEFAULT_MAX_DEPTH): Promise<Map<string, string>> {
    const heads = new Map<string, string>();
    for (const ref of await this.discoverNestedRepos(maxDepth)) {
      const head = await this.nestedRepoHead(ref.absolutePath);
      if (head) heads.set(ref.nestedPath, head);
    }
    return heads;
  }

  private nestedPublicationStateName(record: NestedRepoPublication): string {
    return this.durableIdentityName("nestedpub", [
      record.missionId,
      record.anchoredRepoId,
      record.nestedPath,
      record.baseSha,
      record.headSha,
    ]);
  }

  /**
   * Durable nested-repo publication record: unique tmp filename + atomic
   * rename into the candidate store, same pattern as candidate lifecycles.
   */
  async persistNestedRepoPublication(record: NestedRepoPublication): Promise<void> {
    const dir = await this.candidateStateDir();
    const target = join(dir, this.nestedPublicationStateName(record));
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(record), "utf8");
    await rename(temporary, target);
  }

  /**
   * For every nested standalone repo whose HEAD advanced between execution
   * start (`baseHeads`) and now, record a durable nested repo publication.
   * Repos without a recorded start baseline, or whose HEAD did not advance,
   * produce no record.
   */
  async recordNestedRepoPublications(options: {
    missionId: string;
    anchoredRepoId: string;
    baseHeads?: ReadonlyMap<string, string> | Record<string, string>;
    maxDepth?: number;
  }): Promise<NestedRepoPublication[]> {
    const baseHeads = new Map<string, string>();
    const rawBaseHeads = options.baseHeads;
    if (rawBaseHeads instanceof Map) {
      for (const [key, value] of rawBaseHeads) baseHeads.set(key, value);
    } else if (rawBaseHeads) {
      for (const [key, value] of Object.entries(rawBaseHeads)) baseHeads.set(key, value);
    }
    const records: NestedRepoPublication[] = [];
    for (const ref of await this.discoverNestedRepos(options.maxDepth ?? GitRepo.NESTED_SCAN_DEFAULT_MAX_DEPTH)) {
      const headSha = await this.nestedRepoHead(ref.absolutePath);
      if (!headSha) continue;
      const baseSha = baseHeads.get(ref.nestedPath);
      if (!baseSha || baseSha === headSha) continue;
      const remoteUrl = await this.nestedRepoRemoteUrl(ref.absolutePath);
      let publishedSha: string | null = null;
      if (remoteUrl) {
        const branch = await this.nestedRepoBranch(ref.absolutePath);
        if (branch) publishedSha = await this.nestedRepoPublishedSha(ref.absolutePath, remoteUrl, branch);
      }
      records.push({
        missionId: options.missionId,
        anchoredRepoId: options.anchoredRepoId,
        nestedPath: ref.nestedPath,
        remoteUrl,
        baseSha,
        headSha,
        publishedSha,
        diffStat: await this.nestedRepoDiffStat(ref.absolutePath, baseSha, headSha),
        capturedAt: new Date().toISOString(),
      });
    }
    for (const record of records) await this.persistNestedRepoPublication(record);
    return records;
  }

  /** Durable nested repo publications for one mission + anchored repo. */
  async loadNestedRepoPublications(
    missionId: string,
    anchoredRepoId: string,
  ): Promise<DurableRecordInventory<NestedRepoPublication>> {
    const dir = await this.candidateStateDir(false);
    const records: NestedRepoPublication[] = [];
    const diagnostics: Array<{ file: string; reason: string }> = [];
    for (const name of await readdir(dir).catch(() => [] as string[])) {
      if (!name.startsWith("nestedpub.") || !name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as NestedRepoPublication;
        const structurallyValid =
          typeof parsed.missionId === "string" &&
          parsed.missionId.trim().length > 0 &&
          typeof parsed.anchoredRepoId === "string" &&
          parsed.anchoredRepoId.trim().length > 0 &&
          typeof parsed.nestedPath === "string" &&
          parsed.nestedPath.trim().length > 0 &&
          (parsed.remoteUrl === null || typeof parsed.remoteUrl === "string") &&
          typeof parsed.baseSha === "string" &&
          parsed.baseSha.trim().length > 0 &&
          typeof parsed.headSha === "string" &&
          parsed.headSha.trim().length > 0 &&
          (parsed.publishedSha === null || typeof parsed.publishedSha === "string") &&
          typeof parsed.diffStat === "string" &&
          typeof parsed.capturedAt === "string" &&
          !Number.isNaN(Date.parse(parsed.capturedAt));
        if (!structurallyValid) {
          diagnostics.push({ file: name, reason: "nested publication record has invalid or empty identity fields" });
          continue;
        }
        if (name !== this.nestedPublicationStateName(parsed)) {
          diagnostics.push({ file: name, reason: "nested publication identity does not match canonical filename" });
          continue;
        }
        if (parsed.missionId === missionId && parsed.anchoredRepoId === anchoredRepoId) records.push(parsed);
      } catch (error) {
        diagnostics.push({
          file: name,
          reason: `nested publication record is unreadable: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    records.sort((a, b) => a.nestedPath.localeCompare(b.nestedPath));
    return {
      records: [
        ...new Map(
          records.map((record) => [`${record.nestedPath}\0${record.baseSha}\0${record.headSha}`, record]),
        ).values(),
      ],
      diagnostics,
    };
  }

  /**
   * Re-verify that a recorded publication's nested repo HEAD still equals the
   * recorded headSha (validation gate evidence).
   */
  async verifyNestedRepoPublication(
    record: NestedRepoPublication,
  ): Promise<{ verified: boolean; headSha: string | null }> {
    const head = await this.nestedRepoHead(join(this.repoRoot, record.nestedPath));
    return { verified: head !== null && head === record.headSha, headSha: head };
  }
}

/** A standalone git repository nested inside another repository's tree. */
export interface NestedRepoRef {
  /** Path relative to the anchored repo root (POSIX separators). */
  nestedPath: string;
  absolutePath: string;
}

/**
 * Durable record that a mission's worker published work to a nested standalone
 * repository: the nested HEAD advanced between execution start and end.
 * Accepted as candidate evidence when `headSha !== baseSha` and the work is on
 * the nested remote (`publishedSha === headSha`) or the repo has no remote
 * (`publishedSha === null`).
 */
export interface NestedRepoPublication {
  missionId: string;
  anchoredRepoId: string;
  /** Nested repo location relative to the anchored repo root. */
  nestedPath: string;
  /** `origin`, else the first configured remote, else null (no remote). */
  remoteUrl: string | null;
  /** Nested HEAD at execution start. */
  baseSha: string;
  /** Nested HEAD at execution end. */
  headSha: string;
  /** `git ls-remote <remote> <branch>`; null when no remote or remote lacks the branch. */
  publishedSha: string | null;
  /** `git diff --stat baseSha..headSha` in the nested repo: review evidence without a worktree. */
  diffStat: string;
  capturedAt: string;
}
