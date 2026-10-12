#!/usr/bin/env node
/**
 * Mission doctor: why missions are not finishing, in one page.
 *
 * Reads the durable orchestration stores under ~/.pi/agent/orch-<store>/
 * (orchestration.jsonl and the per-session streams under events/) and prints
 * the Pareto of how missions actually ended — final status, stop reasons,
 * failure categories, execution outcomes — plus the mission time limits
 * currently in force and a durable-record audit for one repository. Everything
 * here is read-only unless --quarantine-unreadable is passed for a repo audit.
 *
 * Usage:
 *   node scripts/mission-doctor.ts [--agent-dir DIR] [--repo PATH]
 *                                  [--limit N] [--json] [--quarantine-unreadable]
 */
import { execFile } from "node:child_process";
import { readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadMissionLimits } from "../src/lifecycle/policy.ts";

interface Ev {
  timestamp?: string;
  type?: string;
  run_id?: string;
  payload?: Record<string, unknown>;
}

interface Args {
  agentDir: string;
  repo?: string;
  limit: number;
  json: boolean;
  quarantine: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { agentDir: join(homedir(), ".pi", "agent"), limit: 0, json: false, quarantine: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent-dir") args.agentDir = resolve(argv[++i] ?? args.agentDir);
    else if (a === "--repo") args.repo = resolve(argv[++i] ?? "");
    else if (a === "--limit") args.limit = Number.parseInt(argv[++i] ?? "0", 10) || 0;
    else if (a === "--json") args.json = true;
    else if (a === "--quarantine-unreadable") args.quarantine = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exitCode = 2;
      return args;
    }
  }
  return args;
}

async function* jsonlFiles(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 2) return;
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const name of entries.sort()) {
    const path = join(dir, name);
    if (name.endsWith(".jsonl")) yield path;
    else if (name === "events" || name === "archive") yield* jsonlFiles(path, depth + 1);
  }
}

/** Strip ids, timestamps and paths so identical reasons group together. */
function normalize(text: string): string {
  return text
    .replace(/[0-9a-f]{16,}/g, "<id>")
    .replace(/(?:MSN|TSK|EXC|TCP|RCV|FC|BLK|AC|F)-[0-9A-Za-z]{5,}/g, "<id>")
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>")
    .replace(/\/[^\s"]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

async function auditRecords(
  repo: string,
  quarantine: boolean,
): Promise<{
  dir: string;
  total: number;
  unreadable: string[];
  stalePath: string[];
  siblingCheckout: number;
  thisCheckout: number;
  quarantined: number;
}> {
  const run = promisify(execFile);
  const commonDir = await run("git", ["-C", repo, "rev-parse", "--git-common-dir"])
    .then(({ stdout }) => resolve(repo, stdout.trim()))
    .catch(() => join(repo, ".git"));
  const dir = join(await commonDir, "pi-engineering-candidates");
  const out = {
    dir,
    total: 0,
    unreadable: [] as string[],
    stalePath: [] as string[],
    siblingCheckout: 0,
    thisCheckout: 0,
    quarantined: 0,
  };
  const rootPrefix = dirname(resolve(repo));
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    out.total++;
    const path = join(dir, name);
    let parsed: { path?: unknown };
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as { path?: unknown };
    } catch (error) {
      out.unreadable.push(name);
      if (quarantine) {
        const at = new Date().toISOString().replace(/[:.]/g, "-");
        const target = join(dir, `${name}.unreadable-${at}`);
        await rename(path, target).catch(() => undefined);
        await writeFile(`${target}.doctor-note.txt`, `quarantined by mission-doctor: ${String(error)}\n`, "utf8");
        out.quarantined++;
      }
      continue;
    }
    const recorded = typeof parsed.path === "string" ? resolve(parsed.path) : "";
    if (!recorded) continue;
    const exists = await stat(recorded)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      // The candidate worktree the record points at is gone (a swept worktree, a
      // checkout that no longer exists). The mission treats such a record as
      // corrupt and blocks every resume, so name it and offer the remedy.
      out.stalePath.push(name);
      if (quarantine) {
        const at = new Date().toISOString().replace(/[:.]/g, "-");
        const target = join(dir, `${name}.stale-${at}`);
        await rename(path, target).catch(() => undefined);
        await writeFile(
          `${target}.doctor-note.txt`,
          `quarantined by mission-doctor: worktree ${recorded} is gone\n`,
          "utf8",
        );
        out.quarantined++;
      }
      continue;
    }
    if (recorded.startsWith(`${rootPrefix}/`)) out.thisCheckout++;
    else out.siblingCheckout++;
  }
  return out;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (process.exitCode === 2) return 2;
  const missions = new Map<
    string,
    { store: string; created: string; updated: string; status: string; title: string; stop?: string }
  >();
  const categories = new Map<string, number>();
  const outcomes = new Map<string, number>();
  const stopReasons = new Map<string, number>();
  const failures = new Map<string, number>();
  const classified = new Map<string, { category: string; summary: string }>();

  const stores: string[] = [];
  for (const entry of await readdir(args.agentDir).catch(() => [] as string[])) {
    if (entry.startsWith("orch-")) stores.push(join(args.agentDir, entry));
  }
  for (const store of stores.sort()) {
    for await (const file of jsonlFiles(store)) {
      let text = "";
      try {
        text = await readFile(file, "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let ev: Ev;
        try {
          ev = JSON.parse(line) as Ev;
        } catch {
          continue;
        }
        const id = ev.run_id;
        if (!id) continue;
        const payload = (ev.payload ?? {}) as Record<string, unknown>;
        if (ev.type === "mission.created") {
          const mission = (payload.mission ?? {}) as { title?: string };
          missions.set(id, {
            store: basename(store),
            created: ev.timestamp ?? "",
            updated: ev.timestamp ?? "",
            status: "STARTED",
            title: (mission.title ?? "").slice(0, 90),
          });
          continue;
        }
        const m = missions.get(id);
        if (!m) continue;
        m.updated = ev.timestamp ?? m.updated;
        if (ev.type === "mission.updated") {
          const patch = (payload.patch ?? {}) as { status?: string };
          if (patch.status) m.status = patch.status;
        } else if (ev.type === "mission.stopped") {
          m.stop = String((payload.stop as { reason?: string } | undefined)?.reason ?? "");
        } else if (ev.type === "mission.failed") {
          m.status = "FAILED";
          m.stop = String(payload.failure_reason ?? "");
        } else if (ev.type === "failure.classified") {
          const c = (payload.classification ?? {}) as {
            classificationId?: string;
            category?: string;
            summary?: string;
          };
          if (c.classificationId)
            classified.set(c.classificationId, { category: c.category ?? "?", summary: c.summary ?? "" });
        } else if (
          ev.type === "execution.failed" ||
          ev.type === "execution.completed" ||
          ev.type === "execution.canceled" ||
          ev.type === "execution.reconciled"
        ) {
          const ex = (payload.execution ?? {}) as { exit_status?: string; status?: string };
          bump(outcomes, `${ev.type.replace("execution.", "")}:${ex.exit_status ?? ex.status ?? "?"}`);
        } else if (ev.type === "task.failed") {
          const reason = (payload.failure_reason as string | undefined) ?? "";
          bump(failures, normalize(reason || "no reason recorded").slice(0, 120));
        } else if (ev.type === "recovery.planned" || ev.type === "recovery.exhausted") {
          const d = (payload.decision ?? {}) as { action?: string; classificationId?: string };
          if (d.action === "STOP") {
            const c = classified.get(d.classificationId ?? "");
            bump(
              stopReasons,
              normalize(`${c?.category ?? "?"}: ${c?.summary ?? d.classificationId ?? "?"}`).slice(0, 140),
            );
          }
        }
      }
    }
  }

  for (const c of classified.values()) bump(categories, c.category);
  for (const m of missions.values()) if (m.stop) bump(stopReasons, normalize(m.stop).slice(0, 140));

  const limits = await loadMissionLimits(process.cwd(), args.agentDir);
  const ranked = (map: Map<string, number>) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  const byStatus = new Map<string, number>();
  for (const m of missions.values()) bump(byStatus, m.status);
  const completed = byStatus.get("COMPLETE") ?? 0;
  const finished = [...missions.values()].filter((m) => ["COMPLETE", "FAILED", "CANCELED"].includes(m.status)).length;

  const recordAudit = args.repo ? await auditRecords(args.repo, args.quarantine) : undefined;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          agentDir: args.agentDir,
          missions: missions.size,
          byStatus: Object.fromEntries(ranked(byStatus)),
          completionRate: finished ? completed / finished : null,
          stopReasons: Object.fromEntries(ranked(stopReasons)),
          failureCategories: Object.fromEntries(ranked(categories)),
          taskFailureReasons: Object.fromEntries(ranked(failures)),
          executionOutcomes: Object.fromEntries(ranked(outcomes)),
          limitsInForce: limits,
          records: recordAudit,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const line = "─".repeat(72);
  console.log(`Mission doctor — ${args.agentDir}`);
  console.log(line);
  console.log(`missions: ${missions.size}   completed: ${completed}   finished: ${finished}`);
  console.log(
    `completion rate: ${finished ? `${Math.round((completed / finished) * 100)}%` : "n/a"}   status: ${ranked(byStatus)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")}`,
  );
  console.log(line);
  console.log("How missions ended (worst first):");
  for (const [reason, count] of ranked(stopReasons).slice(0, args.limit || 12))
    console.log(`  ${String(count).padStart(4)}  ${reason}`);
  console.log(line);
  console.log("Failure categories:");
  for (const [category, count] of ranked(categories).slice(0, args.limit || 12))
    console.log(`  ${String(count).padStart(4)}  ${category}`);
  console.log(line);
  console.log("Execution outcomes:");
  for (const [outcome, count] of ranked(outcomes).slice(0, args.limit || 12))
    console.log(`  ${String(count).padStart(4)}  ${outcome}`);
  console.log(line);
  console.log("Task failure reasons (top):");
  for (const [reason, count] of ranked(failures).slice(0, args.limit || 8))
    console.log(`  ${String(count).padStart(4)}  ${reason}`);
  console.log(line);
  console.log("Mission time limits in force for this process:");
  console.log(`  max_task_wall_clock_ms:    ${limits.max_task_wall_clock_ms ?? "unset (no cap - correct)"}`);
  console.log(`  max_mission_wall_clock_ms: ${limits.max_mission_wall_clock_ms ?? "unset (no cap - correct)"}`);
  console.log(`  worker_inactivity_ms:      ${limits.worker_inactivity_ms}`);
  if (limits.max_task_wall_clock_ms !== undefined || limits.max_mission_wall_clock_ms !== undefined) {
    console.log(
      "  WARNING: a wall-clock cap is configured. It aborts healthy work and is a\n" +
        "           leading BLOCKED cause (docs/mission-time-limits.md). Remove it and\n" +
        "           rely on the inactivity watchdog. Note: a running pi process keeps the\n" +
        "           limits it read at startup; restart pi (or resume, which reloads) after editing.",
    );
  }
  if (recordAudit) {
    console.log(line);
    console.log(`Durable records — ${recordAudit.dir}`);
    console.log(
      `  total: ${recordAudit.total}   this checkout: ${recordAudit.thisCheckout}   sibling checkout: ${recordAudit.siblingCheckout}   unreadable: ${recordAudit.unreadable.length}   stale worktree path: ${recordAudit.stalePath.length}`,
    );
    for (const name of recordAudit.unreadable.slice(0, 10)) console.log(`    unreadable: ${name}`);
    for (const name of recordAudit.stalePath.slice(0, 10)) console.log(`    stale path: ${name}`);
    if (recordAudit.quarantined) console.log(`    quarantined: ${recordAudit.quarantined}`);
    else if (recordAudit.unreadable.length || recordAudit.stalePath.length) {
      console.log(
        '    These block every resume as "Corrupt durable ... record".\n' +
          "    Remedy: re-run with --quarantine-unreadable to move unreadable and\n" +
          "    dangling-worktree records aside (they are renamed, never deleted).",
      );
    }
  }
  return 0;
}

// Use exitCode, not process.exit(), so buffered stdout is flushed before the
// process ends; an early exit() truncated every line of report output.
main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(`mission-doctor failed: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  },
);
