/**
 * `pi-engineering missions list|cancel` — offline operator control over a
 * durable orchestration store whose controller is gone.
 *
 *   missions list   --store <dir|orchestration.jsonl> [--repo-id ID] [--created-after ISO] [--all] [--json]
 *   missions cancel --store <dir|orchestration.jsonl> (--mission ID ... | --repo-id ID --created-after ISO)
 *                   [--yes] [--json]
 *
 * `cancel` is a dry run unless `--yes` is given. The store is opened under its
 * single-writer lock, so this refuses to run while a live `pi` session owns
 * it; no supervisor is started and no Git state is touched.
 */
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JsonlEventStore } from "../platform/eventstore/jsonl.ts";
import { type MissionCancellation, type MissionSelector, cancelStaleMission, listMissions } from "./missionCancel.ts";
import { MissionStore } from "./missionStore.ts";

export interface MissionsCliOptions {
  write?: (text: string) => void;
  error?: (text: string) => void;
  now?: number;
}

const USAGE =
  "usage: pi-engineering missions list --store <dir|orchestration.jsonl> [--repo-id ID] [--created-after ISO] [--all] [--json]\n" +
  "       pi-engineering missions cancel --store <dir|orchestration.jsonl> (--mission ID ... | --repo-id ID --created-after ISO) [--yes] [--json]\n";

function values(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index] === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      out.push(value);
      index++;
    }
  }
  return out;
}

async function storeFile(path: string): Promise<string> {
  const absolute = resolve(path);
  const info = await stat(absolute);
  return info.isDirectory() ? join(absolute, "orchestration.jsonl") : absolute;
}

export async function runMissionsCommand(args: string[], options: MissionsCliOptions = {}): Promise<number> {
  const out = options.write ?? ((value: string) => process.stdout.write(value));
  const err = options.error ?? ((value: string) => process.stderr.write(value));
  const sub = args[0];
  const rest = args.slice(1);
  let selector: MissionSelector;
  let storePath: string;
  try {
    if (sub !== "list" && sub !== "cancel") throw new Error("unknown subcommand");
    const [store] = values(rest, "--store");
    if (!store) throw new Error("--store is required");
    storePath = await storeFile(store);
    selector = {
      repoId: values(rest, "--repo-id")[0],
      createdAfter: values(rest, "--created-after")[0],
      missionIds: values(rest, "--mission"),
      includeTerminal: sub === "list" && rest.includes("--all"),
    };
    if (sub === "cancel" && !selector.missionIds?.length && !(selector.repoId && selector.createdAfter)) {
      throw new Error("cancel requires --mission IDs, or both --repo-id and --created-after");
    }
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
  const json = rest.includes("--json");
  const apply = rest.includes("--yes");

  let backend: JsonlEventStore;
  try {
    backend = await JsonlEventStore.open(storePath);
  } catch (error) {
    err(`cannot open ${storePath}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
  try {
    const store = MissionStore.open(backend);
    const listed = listMissions(store, selector);
    if (sub === "list") {
      out(
        json
          ? `${JSON.stringify(listed, null, 2)}\n`
          : listed.length === 0
            ? "No matching missions.\n"
            : `${listed
                .map(
                  (row) =>
                    `${row.missionId}  ${row.status}${row.stopped ? " (stopped)" : ""}  created ${row.createdAt}  repo ${row.repoIds.join(",") || "unbound"}  ${row.title}`,
                )
                .join("\n")}\n`,
      );
      return 0;
    }
    if (selector.missionIds?.length) {
      const found = new Set(listed.map((row) => row.missionId));
      const missing = selector.missionIds.filter((missionId) => !found.has(missionId));
      if (missing.length > 0) {
        err(`not cancelable (unknown, terminal, or outside the filters): ${missing.join(", ")}\n`);
        return 1;
      }
    }
    if (!apply) {
      out(
        json
          ? `${JSON.stringify({ dryRun: true, missions: listed }, null, 2)}\n`
          : `${listed.length === 0 ? "No matching missions." : `Would cancel:\n${listed.map((row) => `  ${row.missionId}  ${row.status}  ${row.createdAt}`).join("\n")}`}\nRe-run with --yes to cancel.\n`,
      );
      return 0;
    }
    const results: MissionCancellation[] = [];
    const failures: string[] = [];
    for (const row of listed) {
      try {
        results.push(cancelStaleMission(store, row.missionId, { now: options.now }));
      } catch (error) {
        failures.push(`${row.missionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await store.flush();
    if (failures.length > 0) err(`not canceled:\n  ${failures.join("\n  ")}\n`);
    out(
      json
        ? `${JSON.stringify({ dryRun: false, canceled: results }, null, 2)}\n`
        : `${results
            .map(
              (result) =>
                `${result.missionId}  ${result.fromStatus} -> ${result.status}  tasks ${result.canceledTasks.length}  recoveries ${result.settledRecoveries.length}  preserved: ${result.preservedWork.join(", ") || "none"}`,
            )
            .join("\n")}\n`,
    );
    return failures.length > 0 ? 1 : 0;
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    backend.close();
  }
}
