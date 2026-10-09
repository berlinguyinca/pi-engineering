/**
 * `pi-engineering missions list|cancel` — offline operator control over a
 * durable orchestration store whose controller is gone.
 *
 *   missions list   --store <dir|orchestration.jsonl> [--repo-id ID] [--created-after ISO] [--all] [--json]
 *   missions cancel --store <dir|orchestration.jsonl> (--mission ID ... | --repo-id ID --created-after ISO)
 *                   [--yes] [--json]
 *
 * `cancel` is a dry run unless `--yes` is given. The store is opened under its
 * single-writer lock, so this refuses to run while a live `pi` session of a
 * version that still writes this store owns it; no supervisor is started and
 * no Git state is touched.
 *
 * Current runtimes no longer write `orchestration.jsonl`: they import it once
 * into a machine-local runtime namespace (per-session event streams, no
 * cross-process writer lock) and keep every later mission there. Once a store
 * has been imported, this command is neither guarded nor effective (missions
 * created since are not in the file, and the file's lock no longer excludes a
 * live session), so `cancel` refuses and points at `/mission cancel <id>`.
 */
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JsonlEventStore } from "../platform/eventstore/jsonl.ts";
import { MIGRATIONS_FILE } from "../runtime/isolation/legacyMigration.ts";
import { resolveOrchestrationOverride, resolveStateRoot } from "../runtime/isolation/stateDir.ts";
import { type MissionCancellation, type MissionSelector, cancelStaleMission, listMissions } from "./missionCancel.ts";
import { MissionStore } from "./missionStore.ts";

export interface MissionsCliOptions {
  write?: (text: string) => void;
  error?: (text: string) => void;
  now?: number;
  /** Environment used to locate runtime namespaces (defaults to process.env). */
  env?: NodeJS.ProcessEnv;
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
  const file = info.isDirectory() ? join(absolute, "orchestration.jsonl") : absolute;
  // Opening a missing file would create an empty store and report "no
  // missions" for a mistyped path; say what is wrong instead.
  if (!(await stat(file)).isFile()) throw new Error(`${file} is not an orchestration store file`);
  return file;
}

/**
 * The runtime namespace a legacy store was imported into, if any. A namespace
 * records each imported source path in its migrations file.
 */
async function importedInto(storePath: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const namespaces: string[] = [];
  const override = resolveOrchestrationOverride(env);
  if (override) namespaces.push(override);
  const worktrees = join(resolveStateRoot(env), "worktrees");
  try {
    for (const entry of await readdir(worktrees)) namespaces.push(join(worktrees, entry));
  } catch {
    // No runtime state on this machine yet.
  }
  // Records are keyed by the path the runtime saw; compare canonical paths.
  const canonical = (path: string) => realpath(path).catch(() => resolve(path));
  const target = await canonical(storePath);
  for (const namespace of namespaces) {
    let records: unknown;
    try {
      records = JSON.parse(await readFile(join(namespace, MIGRATIONS_FILE), "utf8"));
    } catch {
      continue; // No (readable) migrations file: nothing was imported there.
    }
    if (!records || typeof records !== "object" || Array.isArray(records)) continue;
    for (const source of Object.keys(records)) {
      if ((await canonical(source)) === target) return namespace;
    }
  }
  return null;
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
  const imported = await importedInto(storePath, options.env ?? process.env);
  if (imported && sub === "cancel") {
    err(
      `${storePath} is a legacy store that was imported into the runtime namespace ${imported}; missions now live there, so canceling here would neither reach them nor be guarded against a live session. Cancel from a pi session in that repository with /mission cancel <id>.\n`,
    );
    return 1;
  }
  if (imported) err(`note: ${storePath} is a legacy snapshot imported into ${imported}; it lacks later missions.\n`);

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
