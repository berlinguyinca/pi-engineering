/**
 * UpdateManager: `/engineering update` end to end (spec §11-§17, §39, §40, §47).
 *
 *   CHECK → FETCH → STAGE → VALIDATE → install into versions/ →
 *   WAIT FOR SAFE POINT → QUIESCE → SNAPSHOT → MIGRATE → ACTIVATE →
 *   LOAD → RESTORE → HEALTH CHECK → COMMIT → RESUME
 *
 * Everything up to and including VALIDATE is isolated from the running
 * runtime: a failure there leaves the current runtime, both pointers, `.pi-eng`
 * state, the ledger and every worktree exactly as they were (§15, §47).
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { HandoverResult, HandoverTask } from "../runtime/host/host.ts";
import type { RuntimeTelemetry } from "../runtime/host/telemetry.ts";
import { readStateSchema } from "../runtime/migrations/schema.ts";
import { type SourceCache, type TrustedSource, type UpdateChannel, UpdateSourceError } from "./gitSource.ts";
import { type InstallLayout, versionId } from "./installLayout.ts";
import type { UpdateJournal, UpdateJournalRecord } from "./journal.ts";
import { type CandidateMetadata, MetadataError, parseCandidateMetadata, piCompatible } from "./metadata.ts";
import { MutationLockBusyError, type MutationLockHandle, type RuntimeMutationLock } from "./mutationLock.ts";
import { readPreferences, writePreferences } from "./preferences.ts";
import { type ActivationHost, runActivation } from "./transaction.ts";
import { type ValidationMode, type ValidationStep, provisionDependencies, validateCandidate } from "./validate.ts";

export interface UpdateRequest {
  channel?: UpdateChannel;
  commit?: string;
  force?: boolean;
  verify?: ValidationMode;
}

export interface RunningRuntime {
  version: string;
  commit: string | null;
  label: string;
  root: string;
  /** True when it runs from a mutable git checkout (package/dev). */
  checkout: boolean;
}

export interface UpdateCheckResult {
  current: RunningRuntime | null;
  channel: UpdateChannel;
  target: { sha: string; ref: string; metadata: CandidateMetadata } | null;
  upToDate: boolean;
  pi: { ok: true } | { ok: false; reason: string };
  migration: string;
  failure?: string;
}

export type UpdateOutcome =
  | { status: "refused"; reason: string }
  | { status: "up_to_date"; check: UpdateCheckResult }
  | { status: "failed"; stage: string; reason: string; steps?: ValidationStep[] }
  | { status: "pi_incompatible"; reason: string; staged: string; check: UpdateCheckResult }
  | {
      status: "handover";
      check: UpdateCheckResult;
      steps: ValidationStep[];
      task: HandoverTask;
      done: Promise<{ result: HandoverResult; record: UpdateJournalRecord }>;
    };

export interface UpdateManagerDeps {
  layout: InstallLayout;
  journal: UpdateJournal;
  lock: RuntimeMutationLock;
  telemetry: RuntimeTelemetry;
  cache: SourceCache;
  source: () => TrustedSource;
  activation: ActivationHost;
  running: () => RunningRuntime | null;
  stateDir: () => string | null;
  piVersion: string;
  supportedRuntimeApis: readonly number[];
  defaultValidation: ValidationMode;
  allowDependencyInstall: boolean;
  /** The checkout Pi installed the Host from; seeds repository identity. */
  packageRoot: string;
}

const LEGACY_ENTRY = "src/runtime/host/runtimeEntry.ts";

export class UpdateManager {
  private readonly deps: UpdateManagerDeps;

  constructor(deps: UpdateManagerDeps) {
    this.deps = deps;
  }

  private prefs() {
    return readPreferences(this.deps.layout.preferencesFile);
  }

  /** Repository identity: recorded roots, else the installing checkout's root commit. */
  private identityRoots(): string[] {
    const recorded = this.prefs().identityRoots;
    if (recorded.length > 0) return recorded;
    try {
      return execFileSync("git", ["-C", this.deps.packageRoot, "rev-list", "--max-parents=0", "HEAD"], {
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => /^[0-9a-f]{40}$/.test(s));
    } catch {
      return [];
    }
  }

  private checkChain: Promise<unknown> = Promise.resolve();

  /** `/engineering update --check`: changes no runtime, state, pointer or journal (§13). */
  check(req: UpdateRequest = {}): Promise<UpdateCheckResult> {
    // One fetch at a time into the download cache (an automatic check may
    // overlap an operator's command).
    const run = this.checkChain.then(() => this.checkNow(req));
    this.checkChain = run.catch(() => {});
    return run;
  }

  private async checkNow(req: UpdateRequest): Promise<UpdateCheckResult> {
    const channel = req.channel ?? this.prefs().channel;
    const current = this.deps.running();
    const base: UpdateCheckResult = {
      current,
      channel,
      target: null,
      upToDate: false,
      pi: { ok: true },
      migration: "unknown",
    };
    this.deps.telemetry.emit("runtime.update.check", { channel, from_version: current?.version });
    try {
      const source = this.deps.source();
      await this.deps.cache.fetch(source);
      const target = req.commit
        ? await this.deps.cache.resolveCommit(req.commit)
        : await this.deps.cache.resolveChannel(channel);
      await this.deps.cache.verifyIdentity(target.sha, this.identityRoots());
      const metadata = parseCandidateMetadata(await this.deps.cache.readFile(target.sha, "package.json"), LEGACY_ENTRY);
      const pi = piCompatible(this.deps.piVersion, metadata.minimumPiVersion, metadata.maximumPiVersion);
      const stateDir = this.deps.stateDir();
      const schema = stateDir && existsSync(stateDir) ? readStateSchema(stateDir) : null;
      const s = metadata.stateSchema;
      const migration =
        schema === null
          ? "none"
          : schema >= s.minReadable && schema <= s.maxReadable
            ? "none"
            : schema < s.minReadable
              ? `${schema} → ${s.writes}`
              : `incompatible (state ${schema} newer than ${s.maxReadable})`;
      const upToDate = current?.commit === target.sha;
      const result: UpdateCheckResult = {
        ...base,
        target: { ...target, metadata },
        upToDate,
        pi:
          pi.ok && this.deps.supportedRuntimeApis.includes(metadata.runtimeApi)
            ? { ok: true }
            : { ok: false, reason: pi.ok ? `runtime API ${metadata.runtimeApi} unsupported` : pi.reason },
        migration,
      };
      if (!upToDate) {
        this.deps.telemetry.emit("runtime.update.available", {
          channel,
          from_version: current?.version,
          to_version: metadata.version,
          from_commit: current?.commit ?? null,
          to_commit: target.sha,
        });
      }
      return result;
    } catch (error) {
      const failure =
        error instanceof UpdateSourceError || error instanceof MetadataError
          ? error.message
          : `update check failed: ${error instanceof Error ? error.message : String(error)}`;
      return { ...base, failure };
    }
  }

  /** Is the running runtime a git checkout with uncommitted changes? (§40) */
  dirtyCheckout(): string | null {
    const running = this.deps.running();
    if (!running?.checkout || !existsSync(join(running.root, ".git"))) return null;
    try {
      const out = execFileSync("git", ["-C", running.root, "status", "--porcelain"], {
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      return out.trim() ? running.root : null;
    } catch {
      return null;
    }
  }

  async update(req: UpdateRequest = {}, progress: (line: string) => void = () => {}): Promise<UpdateOutcome> {
    let lock: MutationLockHandle;
    try {
      lock = this.deps.lock.acquire("update");
    } catch (error) {
      if (error instanceof MutationLockBusyError) return { status: "refused", reason: error.message };
      throw error;
    }
    let handedOver = false;
    try {
      const dirty = this.dirtyCheckout();
      if (dirty) {
        return {
          status: "refused",
          reason: "Local pi-engineering checkout contains uncommitted changes.\nAutomatic update refused.",
        };
      }
      const check = await this.check(req);
      if (check.failure || !check.target) {
        this.deps.telemetry.emit("runtime.update.failed", { failure_reason: check.failure, channel: check.channel });
        return { status: "failed", stage: "check", reason: check.failure ?? "no update target" };
      }
      if (check.upToDate && !req.force) return { status: "up_to_date", check };
      const outcome = await this.stageValidateActivate(req, check, progress);
      handedOver = outcome.status === "handover";
      if (outcome.status === "handover") {
        // Preferences are written before `done` resolves, and the lock is held
        // until both are finished.
        const done = outcome.done
          .then(async (finished) => {
            if (finished.result.ok) {
              // A channel switch is remembered; a commit pin is one-off (§12).
              const prefs = this.prefs();
              // Repository identity: recorded roots, else the installing
              // checkout's, else trust-on-first-use of the commit just
              // validated, so the check is never silently left off.
              let roots = prefs.identityRoots.length > 0 ? prefs.identityRoots : this.identityRoots();
              if (roots.length === 0 && outcome.check.target) {
                roots = await this.deps.cache.rootsOf(outcome.check.target.sha).catch(() => []);
              }
              await writePreferences(this.deps.layout.preferencesFile, {
                ...prefs,
                identityRoots: roots,
                ...(req.channel && !req.commit ? { channel: req.channel } : {}),
              }).catch(() => {});
            }
            return finished;
          })
          .finally(() => lock.release());
        return { ...outcome, done };
      }
      return outcome;
    } finally {
      if (!handedOver) lock.release();
    }
  }

  private async stageValidateActivate(
    req: UpdateRequest,
    check: UpdateCheckResult,
    progress: (line: string) => void,
  ): Promise<UpdateOutcome> {
    const { layout, journal, telemetry } = this.deps;
    const target = check.target as NonNullable<UpdateCheckResult["target"]>;
    const running = check.current;
    const transaction = `update-${target.sha.slice(0, 12)}-${randomBytes(3).toString("hex")}`;
    const fields = {
      transaction_id: transaction,
      channel: req.commit ? `commit:${target.sha.slice(0, 12)}` : check.channel,
      from_version: running?.version,
      to_version: target.metadata.version,
      from_commit: running?.commit ?? null,
      to_commit: target.sha,
      runtime_api: target.metadata.runtimeApi,
    };
    telemetry.emit("runtime.update.started", fields);
    let record = journal.begin({
      transaction,
      kind: "update",
      channel: fields.channel,
      fromVersion: running?.version ?? null,
      fromCommit: running?.commit ?? null,
      toVersion: target.metadata.version,
      toCommit: target.sha,
      previousRuntime: running?.root ?? null,
      candidateRuntime: null,
      pointers: { current: layout.readPointer("current"), previous: layout.readPointer("previous") },
      phase: "fetching",
    });
    telemetry.emit("runtime.update.fetched", fields);
    progress("✓ downloaded");

    const staged = join(layout.stagingDir, `${transaction}`);
    record = journal.advance(record, "staging", { candidateRuntime: staged });
    try {
      await this.deps.cache.exportTree(target.sha, staged);
    } catch (error) {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
      const reason = error instanceof Error ? error.message : String(error);
      journal.advance(record, "failed", { failure: `staging failed: ${reason}` });
      telemetry.emit("runtime.update.failed", { ...fields, failure_reason: reason });
      return { status: "failed", stage: "stage", reason };
    }
    const id = versionId(target.metadata.version, target.sha);
    await layout.writeMeta(staged, {
      id,
      version: target.metadata.version,
      commit: target.sha,
      channel: fields.channel,
      source: this.deps.source().remote,
      installedAt: new Date().toISOString(),
      runtimeApi: target.metadata.runtimeApi,
      stateSchema: target.metadata.stateSchema,
    });
    telemetry.emit("runtime.update.staged", fields);
    progress("✓ staged");

    if (!check.pi.ok) {
      const reason = `Pi Engineering ${target.metadata.version} requires a newer Pi runtime (${check.pi.reason}).\n\nCandidate downloaded but not activated.\nPi update/restart required.`;
      journal.advance(record, "failed", { failure: `activation refused: ${check.pi.reason}` });
      telemetry.emit("runtime.update.refused", { ...fields, failure_reason: check.pi.reason });
      return { status: "pi_incompatible", reason, staged, check };
    }

    record = journal.advance(record, "validating");
    const deps = await provisionDependencies(staged, running?.root ?? null, {
      allowInstall: this.deps.allowDependencyInstall,
    });
    const validation =
      deps.status === "failed"
        ? { ok: false as const, steps: [deps] }
        : await validateCandidate({
            dir: staged,
            metadata: target.metadata,
            runningPiVersion: this.deps.piVersion,
            supportedRuntimeApis: this.deps.supportedRuntimeApis,
            stateDir: this.deps.stateDir(),
            mode: req.verify ?? this.deps.defaultValidation,
          });
    const steps = [deps, ...validation.steps];
    if (!validation.ok || !("migration" in validation) || !validation.migration) {
      await rm(staged, { recursive: true, force: true }).catch(() => {});
      const failed = steps.find((s) => s.status === "failed");
      const reason = failed ? `${failed.name}: ${failed.detail ?? "failed"}` : "validation failed";
      journal.advance(record, "failed", { failure: `validation failed: ${reason}` });
      telemetry.emit("runtime.update.failed", { ...fields, failure_reason: reason });
      return { status: "failed", stage: "validate", reason, steps };
    }
    telemetry.emit("runtime.update.validated", fields);
    progress("✓ validated");
    progress("✓ compatible");

    const versionDir = await layout.install(staged, id);
    record = journal.advance(record, "validating", { candidateRuntime: versionDir });
    const { task, done } = await runActivation({
      host: this.deps.activation,
      journal,
      record,
      candidateDir: versionDir,
      kind: "update",
      stateDir: this.deps.stateDir(),
      migration: validation.migration,
      fields,
    });
    return { status: "handover", check, steps, task, done };
  }
}
