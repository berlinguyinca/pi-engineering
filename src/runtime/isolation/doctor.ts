/**
 * `pi-engineering doctor [--repair]` (spec §26).
 *
 * Visibility for unusual cases; normal operation self-heals without it. The
 * doctor never registers itself as a session. `--repair` performs only safe
 * operations: the same reconciliation every session runs at startup (orphan
 * provably dead sessions, reclaim their leases, quarantine torn tails of dead
 * writers), pending legacy imports, quarantining a corrupt registry, and moving
 * aside a legacy writer lock whose owner is provably gone.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RecoveryManager } from "./RecoveryManager.ts";
import { RuntimeRegistry } from "./RuntimeRegistry.ts";
import { openRegistryWithRecovery } from "./RuntimeSession.ts";
import { resolveWorktreeIdentity } from "./WorktreeIdentity.ts";
import { filesystemInfo } from "./fsType.ts";
import { endsCleanly, readJsonlFrom } from "./jsonlFiles.ts";
import { legacyTargetName, migrateLegacyStore, readMigrationRecords } from "./legacyMigration.ts";
import { integrityCheck, journalMode } from "./sqlite.ts";
import {
  resolveOrchestrationOverride,
  resolveRegistryLocation,
  resolveStateRoot,
  worktreeRuntimeDir,
} from "./stateDir.ts";

export type CheckStatus = "ok" | "info" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Issues `--repair` can fix safely. */
  repairable: number;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  repairableIssues: number;
  repaired: string[];
  fatal: boolean;
}

function writable(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.doctor-${process.pid}-${randomUUID()}`);
    writeFileSync(probe, "", { flag: "wx" });
    rmSync(probe, { force: true });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Legacy `.pi-eng/orchestration.jsonl.lock`: unused now; safe to move aside only when its owner is gone. */
function legacyLockState(lockPath: string): "absent" | "held" | "stale" {
  if (!existsSync(lockPath)) return "absent";
  try {
    const owner = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown };
    if (typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
      return pidAlive(owner.pid) ? "held" : "stale";
    }
    return "stale";
  } catch {
    return "stale";
  }
}

export async function runDoctor(options: {
  cwd: string;
  repair?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const repair = options.repair ?? false;
  const checks: DoctorCheck[] = [];
  const repaired: string[] = [];
  const stateRoot = resolveStateRoot(env);
  const location = resolveRegistryLocation(stateRoot, env);

  const stateProblem = writable(stateRoot);
  checks.push({
    name: "State directory",
    status: stateProblem ? "fail" : "ok",
    detail: stateProblem ? `${stateRoot}: ${stateProblem}` : stateRoot,
    repairable: 0,
  });

  // ── registry ──
  let registry: RuntimeRegistry | null = null;
  try {
    try {
      registry = RuntimeRegistry.open(location.file);
    } catch (error) {
      if (
        !repair ||
        !/not a database|malformed|corrupt/i.test(error instanceof Error ? error.message : String(error))
      ) {
        throw error;
      }
      registry = await openRegistryWithRecovery(location.file, "doctor");
      repaired.push(`quarantined corrupt registry and rebuilt ${location.file}`);
    }
    const integrity = integrityCheck(registry.db);
    checks.push({
      name: "Runtime registry",
      status: integrity === "ok" ? "ok" : "fail",
      detail: `${location.file}${location.relocatedBecause ? ` (relocated: ${location.relocatedBecause})` : ""}${integrity === "ok" ? "" : `: ${integrity}`}`,
      repairable: 0,
    });
    const mode = journalMode(registry.db);
    checks.push({ name: "SQLite WAL", status: mode === "WAL" ? "ok" : "warn", detail: mode, repairable: 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const corrupt = /not a database|malformed|corrupt/i.test(message);
    checks.push({
      name: "Runtime registry",
      status: "fail",
      detail: `${location.file}: ${message}`,
      repairable: corrupt ? 1 : 0,
    });
  }

  // ── worktree resolution ──
  const identity = await resolveWorktreeIdentity(options.cwd);
  checks.push({
    name: "Worktree resolution",
    status: "ok",
    detail: `${identity.kind === "git" ? identity.repoName : "(not a git worktree)"} ${identity.worktreeRoot} [${identity.worktreeId.slice(0, 8)}…]`,
    repairable: 0,
  });

  // ── sessions / leases ──
  if (registry) {
    const sessions = registry.list();
    const stale = sessions.filter((session) => registry!.assess(session).verdict === "dead");
    const active = sessions.length - stale.length;
    checks.push({ name: "Active sessions", status: "info", detail: String(active), repairable: 0 });
    checks.push({
      name: "Stale sessions",
      status: stale.length > 0 ? "warn" : "ok",
      detail:
        stale.length > 0
          ? `${stale.length} (${stale.map((session) => `${session.sessionId.slice(0, 8)} pid ${session.pid}`).join(", ")})`
          : "0",
      repairable: stale.length,
    });
    const leases = registry.leases.list();
    checks.push({ name: "Leases", status: "info", detail: String(leases.length), repairable: 0 });
  }

  // ── event streams ──
  const override = resolveOrchestrationOverride(env);
  const namespace = override ?? worktreeRuntimeDir(stateRoot, identity.worktreeId);
  const recovery = registry ? new RecoveryManager(registry, { stateRoot }) : null;
  const namespaces = new Set<string>([namespace, ...(recovery?.namespaceDirs() ?? [])]);
  let streams = 0;
  let malformed = 0;
  let tornDead = 0;
  let tornLive = 0;
  for (const dir of namespaces) {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, "events")).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      streams++;
      const file = join(dir, "events", name);
      if (dir === namespace) malformed += readJsonlFrom(file, 0).corruptLines;
      if (endsCleanly(file)) continue;
      const writer = registry?.get(name.slice(0, -".jsonl".length));
      if (writer && registry?.assess(writer).verdict !== "dead") tornLive++;
      else tornDead++;
    }
  }
  checks.push({
    name: "Event streams",
    status: tornDead > 0 ? "warn" : malformed > 0 ? "warn" : "ok",
    detail: `${streams} stream(s)${tornDead ? `, ${tornDead} truncated (dead writer)` : ""}${tornLive ? `, ${tornLive} mid-append (live writer)` : ""}${malformed ? `, ${malformed} malformed line(s) skipped` : ""}`,
    repairable: tornDead,
  });

  // ── filesystems ──
  const stateFs = filesystemInfo(existsSync(stateRoot) ? stateRoot : options.cwd);
  const repoFs = filesystemInfo(identity.worktreeRoot);
  checks.push({
    name: "Filesystem",
    status: repoFs.network || stateFs.network ? "info" : "ok",
    detail: `state ${stateFs.type}${stateFs.network ? " (network; registry kept machine-local)" : ""}, worktree ${repoFs.type}${repoFs.network ? " (network)" : ""}`,
    repairable: 0,
  });

  // ── legacy migration / legacy lock ──
  const legacyFile = join(identity.worktreeRoot, ".pi-eng", "orchestration.jsonl");
  if (existsSync(legacyFile)) {
    const record = readMigrationRecords(namespace)[legacyFile];
    const imported = existsSync(join(namespace, "events", legacyTargetName(legacyFile)));
    checks.push({
      name: "Legacy migration",
      status: record && imported ? "ok" : "warn",
      detail: record && imported ? `imported ${record.events} event(s) at ${record.completedAt}` : "pending",
      repairable: record && imported ? 0 : 1,
    });
  } else {
    checks.push({ name: "Legacy migration", status: "ok", detail: "no legacy store", repairable: 0 });
  }
  const legacyLock = `${legacyFile}.lock`;
  const lockState = legacyLockState(legacyLock);
  checks.push({
    name: "Legacy writer lock",
    status: lockState === "stale" ? "warn" : "ok",
    detail:
      lockState === "absent"
        ? "none"
        : lockState === "held"
          ? "held by a live older Pi Engineering process (no longer used by this version)"
          : "stale (owner gone or unreadable; no longer used)",
    repairable: lockState === "stale" ? 1 : 0,
  });

  // ── repair ──
  if (repair) {
    if (registry && recovery) {
      const result = recovery.reconcile();
      for (const session of result.orphanedSessions)
        repaired.push(`orphaned stale session ${session.sessionId} (${session.reason})`);
      for (const lease of result.reclaimedLeases) repaired.push(`released lease ${lease.resourceId} (${lease.reason})`);
      for (const stream of result.repairedStreams)
        repaired.push(`quarantined torn tail of ${stream.stream} → ${stream.quarantine}`);
    }
    if (existsSync(legacyFile)) {
      try {
        const migrated = migrateLegacyStore({
          legacyFile,
          runtimeDir: namespace,
          eventsDir: join(namespace, "events"),
        });
        if (migrated.status === "migrated") repaired.push(`imported legacy store ${legacyFile}`);
      } catch (error) {
        repaired.push(`legacy import failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (lockState === "stale") {
      const recoveryDir = join(namespace, "recovery");
      mkdirSync(recoveryDir, { recursive: true });
      const target = join(
        recoveryDir,
        `stale-lock-${new Date()
          .toISOString()
          .replace(/[-:]/g, "")
          .replace(/\.\d+Z$/, "Z")}.json`,
      );
      try {
        renameSync(legacyLock, target);
        repaired.push(`moved stale legacy lock to ${target}`);
      } catch {
        // Gone already or not movable; reported again next run.
      }
    }
    // Re-evaluate what remains after repair.
    for (const check of checks) {
      if (check.name === "Stale sessions" && registry) {
        const remaining = registry.list().filter((session) => registry!.assess(session).verdict === "dead").length;
        check.repairable = remaining;
        if (remaining === 0) {
          check.status = "ok";
          check.detail = `0 (repaired)`;
        }
      }
      if (check.name === "Event streams" && check.repairable > 0) {
        check.repairable = 0;
        check.status = "ok";
        check.detail += " (repaired)";
      }
      if (
        check.name === "Legacy migration" &&
        check.repairable > 0 &&
        repaired.some((r) => r.startsWith("imported legacy"))
      ) {
        check.repairable = 0;
        check.status = "ok";
        check.detail = "imported (repaired)";
      }
      if (check.name === "Legacy writer lock" && check.repairable > 0 && !existsSync(legacyLock)) {
        check.repairable = 0;
        check.status = "ok";
        check.detail = "moved aside (repaired)";
      }
      if (check.name === "Runtime registry" && check.repairable > 0 && registry) {
        check.repairable = 0;
        check.status = "ok";
        check.detail += " (rebuilt)";
      }
    }
  }
  registry?.close();
  const repairableIssues = checks.reduce((sum, check) => sum + check.repairable, 0);
  return {
    checks,
    repairableIssues,
    repaired,
    fatal: checks.some((check) => check.status === "fail" && check.repairable === 0),
  };
}

const STATUS_LABEL: Record<CheckStatus, string> = { ok: "OK", info: "", warn: "WARN", fail: "FAIL" };

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ["Pi Engineering Doctor", ""];
  for (const check of report.checks) {
    const label = STATUS_LABEL[check.status];
    lines.push(`${check.name.padEnd(24)}${label ? `${label}  ` : ""}${check.detail}`);
  }
  lines.push(`${"Repairable issues".padEnd(24)}${report.repairableIssues}`);
  if (report.repaired.length > 0) {
    lines.push("", "Repaired:");
    for (const entry of report.repaired) lines.push(`  - ${entry}`);
  } else if (report.repairableIssues > 0) {
    lines.push("", "Run `pi-engineering doctor --repair` to fix repairable issues safely.");
  }
  return lines.join("\n");
}

/** CLI exit code: 0 healthy, 1 repairable issues remain, 2 fatal. */
export function doctorExitCode(report: DoctorReport): number {
  if (report.fatal) return 2;
  return report.repairableIssues > 0 ? 1 : 0;
}
