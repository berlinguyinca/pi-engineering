/**
 * `pi-engineering runtime-ops ...` — read-only operational status.
 *
 * The exit code is the answer to "is this runtime healthy", so it can gate a script: 0 healthy/known, 1 a
 * check failed or the target is unknown, 2 usage, 3 the configured store could not be opened. Exit codes
 * never encode "there is no data" — a runtime that has not run yet is known, not broken.
 */
import { RuntimeOpsView, resolveRuntimeOpsConfig } from "./runtimeOpsService.ts";

const USAGE = `usage: pi-engineering runtime-ops <status|health|missions|tasks|task|config> [flags]

  status    [--store <dir|file>] [--registry <file>] [--window-minutes N] [--json]
            state root, session liveness, leases, missions by status, recent events
  health    [--store <dir|file>] [--registry <file>] [--json]    can each durable source be read at all
  missions  [--store <dir|file>] [--json]                        every mission, its status and blocking reason
  tasks     [--store <dir|file>] [--mission <ID>] [--status S]... [--limit N] [--json]
  task      <TASK-ID> [--store <dir|file>] [--at-ref HEAD|worktree] [--json]
                                                            one task: evidence left, acceptance criteria,
                                                            citation drift over the documents it produced
  config    [--config <file>] [--json]                           how the config resolved (arg > env > file > defaults)

Read-only: the orchestration store is opened through its read-only path, so status works while a worker
holds the writer lock, and nothing here can advance mission or task state. Flags for the retry / resume /
cancel / re-run decisions live on \`pi-engineering missions\`, where the authority checks are.`;

function values(args: string[], flag: string): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1] !== undefined) {
      found.push(args[index + 1]!);
      index += 1;
    } else if (args[index]?.startsWith(`${flag}=`)) {
      found.push(args[index]!.slice(flag.length + 1));
    }
  }
  return found;
}

function emit(out: (value: string) => void, json: boolean, payload: unknown, text: () => string): void {
  out(json ? `${JSON.stringify(payload, null, 2)}\n` : `${text()}\n`);
}

export async function runRuntimeOpsCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: { write?: (value: string) => void; error?: (value: string) => void; cwd?: string; repoRoot?: string } = {},
): Promise<number> {
  const out = io.write ?? ((value: string) => process.stdout.write(value));
  const err = io.error ?? ((value: string) => process.stderr.write(value));
  const cwd = io.cwd ?? process.cwd();
  const repoRoot = io.repoRoot ?? cwd;
  const verb = args[0];
  const rest = args.slice(1);
  const json = rest.includes("--json");
  const store = values(rest, "--store")[0] ?? null;
  const registryArg = values(rest, "--registry")[0] ?? null;
  const configPath = values(rest, "--config")[0] ?? null;

  if (typeof verb !== "string" || verb === "" || verb.startsWith("--")) {
    err(`${USAGE}\n`);
    return 2;
  }

  const resolution = resolveRuntimeOpsConfig({ repoRoot, env, configPath, cwd });
  // --store and --registry are per-invocation overrides of the configured sources, nothing else.
  const view = RuntimeOpsView.open({
    ...resolution,
    config: { ...resolution.config, ...(store !== null ? { orchestrationStore: store } : {}), ...(registryArg !== null ? { registryFile: registryArg } : {}) },
  });

  if (verb === "config") {
    emit(out, json, { source: resolution.source, problems: resolution.problems, config: resolution.config }, () =>
      [`source=${resolution.source}`, `stateRoot=${resolution.config.stateRoot}`, `orchestrationStore=${resolution.config.orchestrationStore ?? "(auto-discovered)"}`, `specsDir=${resolution.config.specsDir}`, `staleAfterMs=${resolution.config.staleAfterMs}`, ...resolution.problems.map((problem) => `problem: ${problem}`)].join("\n"),
    );
    return resolution.problems.length === 0 ? 0 : 1;
  }

  if (verb === "health") {
    const report = await view.health();
    emit(out, json, report, () =>
      [
        `${report.ok ? "HEALTHY" : "NOT HEALTHY"} (config source ${report.configSource})`,
        ...report.checks.map((check) => `  ${check.ok ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`),
      ].join("\n"),
    );
    const storeFailed = report.checks.some((check) => check.name === "orchestrationStore" && !check.ok);
    return report.ok ? 0 : storeFailed ? 3 : 1;
  }

  if (verb === "status" || verb === "missions") {
    const windowMinutes = Number(values(rest, "--window-minutes")[0] ?? "15");
    const report = await view.runtimeStatus({ windowMs: Number.isFinite(windowMinutes) && windowMinutes > 0 ? windowMinutes * 60_000 : 15 * 60_000 });
    emit(out, json, report, () => {
      const lines = [`runtime status at ${report.checkedAt} (heartbeat older than ${report.staleAfterMs} ms is reported stale)`, report.stateRoot.available ? `state root ${report.stateRoot.data.path}: ${report.stateRoot.data.namespaces.length} namespace(s)` : `state root: ${report.stateRoot.reason}`];
      if (verb === "status") {
        lines.push(
          `registry ${report.registryFile}: ${report.leases.available ? `${report.leases.data.total} lease(s) — ${report.leases.data.held} unexpired, ${report.leases.data.expired} past expiry${report.leases.data.foreignHosts > 0 ? `, ${report.leases.data.foreignHosts} on other hosts` : ""}` : report.leases.reason}`,
          report.sessions.available
            ? `sessions: ${report.sessions.data.total} registered — ${report.sessions.data.fresh} fresh, ${report.sessions.data.stale} stale, ${report.sessions.data.unknown} unknown (heartbeat window ${report.staleAfterMs} ms)`
            : `sessions: ${report.sessions.reason}`,
          report.missions.available
            ? `missions: ${report.missions.data.total} (${Object.entries(report.missions.data.byStatus).map(([status, count]) => `${status}=${count}`).join(", ") || "none"})`
            : `missions: unavailable — ${report.missions.reason}`,
          report.activity.available
            ? `events in the last ${Math.round(report.activity.data.windowMs / 60000)} min: ${report.activity.data.events.length}${report.activity.data.newest !== null ? ` (newest ${report.activity.data.newest})` : ""}`
            : `events: unavailable — ${report.activity.reason}`,
        );
      }
      if (verb === "status" && report.leases.available) {
        for (const lease of report.leases.data.items.slice(0, 8)) {
          lines.push(`  ${lease.resourceId} session=${lease.sessionId.slice(0, 8)} pid=${lease.pid} holder=${lease.holder} (${lease.holderReason}) ${lease.expired ? `expired ${Math.abs(Math.round(lease.ttlMs / 1000))}s ago` : `${Math.round(lease.ttlMs / 1000)}s left`}`);
        }
      }
      if (report.sessions.available) {
        for (const session of report.sessions.data.items.slice(0, 10)) {
          lines.push(`  ${session.sessionId} pid=${session.pid} ${session.liveness}${session.ageMs !== null ? ` (${Math.round(session.ageMs / 1000)}s)` : ""} pidAlive=${session.processAlive} ${session.cwd}`);
        }
      }
      if (report.missions.available) {
        for (const mission of report.missions.data.active) {
          lines.push(`  ${mission.missionId} ${mission.status} tasks=${mission.taskCount} updated=${mission.updatedAt}${mission.blockedReason !== null ? ` blocked=${mission.blockedReason}` : ""} — ${mission.title}`);
        }
        if (report.missions.data.active.length === 0) lines.push("  no mission is in a non-terminal state");
      }
      return lines.join("\n");
    });
    // "Nothing has ever run here" is a known state, not a broken store: only a real open failure exits 3.
    if (!report.missions.available) return report.missions.reason.includes("no orchestration store") ? 0 : 3;
    if (verb === "status") {
      const staleSessions = report.sessions.available && report.sessions.data.stale > 0;
      const contradicted = (report.sessions.available && report.sessions.data.items.some((session) => session.liveness === "fresh" && !session.processAlive))
        || (report.leases.available && report.leases.data.items.some((lease) => lease.expired && lease.holder === "alive"));
      const staleMissions = report.missions.data.active.some((mission) => Date.parse(mission.updatedAt) < Date.now() - report.staleAfterMs);
      return staleSessions || contradicted || staleMissions ? 1 : 0;
    }
    return 0;
  }

  if (verb === "tasks") {
    const statuses = values(rest, "--status");
    const limit = Number(values(rest, "--limit")[0] ?? "200");
    const report = await view.tasks({ missionId: values(rest, "--mission")[0] ?? null, statuses, limit: Number.isFinite(limit) && limit > 0 ? limit : 200 });
    emit(out, json, report, () =>
      [
        `${report.total} task(s)${report.truncated ? ` (truncated to ${report.filter.limit})` : ""}`,
        ...report.tasks.map((task) => `  ${task.taskId} [${task.status}] ${task.kind}/${task.role} attempt=${task.attempt}/${task.maxAttempts} artifacts=${task.artifactCount}${task.dependsOn.length > 0 ? ` depends=${task.dependsOn.join(",")}` : ""} — ${task.objective}`),
      ].join("\n"),
    );
    return 0;
  }

  if (verb === "task") {
    const taskId = rest.find((argument) => !argument.startsWith("--"));
    if (typeof taskId !== "string" || taskId === "") {
      err(`task needs a task id\n${USAGE}\n`);
      return 2;
    }
    const report = await view.taskDetail(taskId, { atRef: values(rest, "--at-ref")[0] ?? "HEAD" });
    emit(out, json, report, () => {
      if (!report.found) return `task ${report.taskId}: ${report.reason}`;
      const lines = [`${report.task!.taskId} [${report.task!.status}] ${report.task!.kind}/${report.task!.role} in ${report.task!.missionId}`, `  objective: ${report.task!.objective}`, `  attempt ${report.task!.attempt}/${report.task!.maxAttempts} started=${report.task!.startedAt ?? "-"} completed=${report.task!.completedAt ?? "-"}`];
      lines.push(report.mission?.available === true ? `  mission ${report.mission.data.missionId} [${report.mission.data.status}]: ${report.mission.data.acceptanceCriteria.length} acceptance criteria` : `  mission: ${report.mission?.available === false ? report.mission.reason : "unknown"}`);
      if (report.mission?.available === true) {
        for (const criterion of report.mission.data.acceptanceCriteria) lines.push(`    [${criterion.status}] ${criterion.criterion}${criterion.evidence !== undefined ? ` evidence=${criterion.evidence}` : ""}`);
      }
      if (report.artifacts !== undefined) {
        lines.push(`  artifacts: ${report.artifacts.repoRelative.length + report.artifacts.absolute.length} declared, ${report.artifacts.missing.length} absent from disk${report.artifacts.missing.length > 0 ? ` (${report.artifacts.missing.slice(0, 5).join(", ")})` : ""}`);
      }
      if (report.citationDrift !== undefined) {
        lines.push(`  citation drift (${report.citationDrift.atRef}): ${report.citationDrift.status === "checked" ? `${report.citationDrift.summary ?? "checked"} across ${report.citationDrift.documents?.length ?? 0} document(s)` : `not checked — ${report.citationDrift.reason}`}`);
      }
      return lines.join("\n");
    });
    if (!report.found) return 1;
    const drift = report.citationDrift;
    return drift !== undefined && drift.status === "checked" && (drift.report?.unresolved.length ?? 0) > 0 ? 1 : 0;
  }

  err(`unknown runtime-ops verb ${verb}\n${USAGE}\n`);
  return 2;
}
