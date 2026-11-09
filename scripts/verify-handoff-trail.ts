/**
 * V07: run `verifyTrail` against a finished trail on disk. Read-only: it never writes a record, never commits,
 * never pushes and never invokes a model. Exit code is 0 only when the trail has no issue at all.
 *
 *   tsx scripts/verify-handoff-trail.ts --trail docs/specs/harness-reliability-bootstrap-20261103 [--rev <sha>] [--json]
 *
 * Record order comes from the plan manifest, never from the records. Where a unit has more than one generation the
 * newest wins (`out-final` > `out-corrected` > `out2` > `out` > the unit root), which is the rule the conductor's
 * own ledger states; a superseded generation is still hashed by nothing here and is reported nowhere - it is only
 * never the record that is verified. Evidence is checked twice: on disk, and as a blob at `--rev` (default HEAD),
 * because a working tree is not a repository.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  GENERATION_ORDER,
  type LiveProcess,
  type TrailRecordGeneration,
  matchLiveRunners,
  mentionsCommand,
  selectCanonical,
  unreadGenerations,
  verifyTrail,
} from "../src/bootstrap/trailVerifier.ts";

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? (process.argv[index + 1] as string) : fallback;
};
const trail = resolve(arg("trail", "docs/specs/harness-reliability-bootstrap-20261103"));
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const rev = arg("rev", "HEAD");
/** A record names its artifacts repo-relative; a trail written before that convention named them trail-relative. */
const candidates = (path: string): string[] => [
  ...new Set([path, relative(root, join(trail, path)).replace(/\\/gu, "/")]),
];
const onDisk = (path: string): boolean => candidates(path).some((candidate) => existsSync(resolve(root, candidate)));
const committed = (path: string): boolean =>
  candidates(path).some((candidate) => {
    try {
      execFileSync("git", ["cat-file", "-e", `${rev}:${candidate}`], { cwd: root, stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });

const manifest = JSON.parse(readFileSync(join(trail, "manifests", "tasks.json"), "utf8")) as {
  tasks: { id: string }[];
};
const order = manifest.tasks.map((task) => task.id);
const schema = JSON.parse(readFileSync(join(trail, "templates", "handoff.schema.json"), "utf8"));
const records: TrailRecordGeneration[] = [];
const unread = new Set<string>();
for (const entry of readdirSync(trail, { withFileTypes: true }).filter(
  (dirent) => dirent.isDirectory() && !["manifests", "templates", "logs", "out"].includes(dirent.name),
)) {
  // A generation directory the reader does not rank is surfaced, never quietly skipped.
  for (const name of unreadGenerations(
    readdirSync(join(trail, entry.name), { withFileTypes: true })
      .filter((dir) => dir.isDirectory())
      .map((dir) => dir.name),
  ))
    unread.add(`${entry.name}/${name}`);
  GENERATION_ORDER.forEach((generation, rank) => {
    const file = join(trail, entry.name, generation, `${entry.name}.handoff.json`);
    if (generation !== "" && !existsSync(file)) return;
    if (generation === "" && !existsSync(join(trail, entry.name, `${entry.name}.handoff.json`))) return;
    records.push({
      taskId: entry.name,
      generation: rank,
      record: JSON.parse(
        readFileSync(generation === "" ? join(trail, entry.name, `${entry.name}.handoff.json`) : file, "utf8"),
      ) as Record<string, unknown>,
    });
  });
}
/**
 * Processes still alive, with the directory each was started in where the platform will say (`/proc` on Linux, `lsof`
 * on macOS). The cwd is resolved only for processes that already quote a recorded command, so this costs nothing on a
 * quiet machine and a handful of syscalls on a busy one.
 */
function liveProcesses(recorded: readonly string[]): LiveProcess[] {
  const out: LiveProcess[] = [];
  for (const row of execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")) {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(row);
    if (match === null) continue;
    const pid = Number(match[1]);
    const command = (match[2] ?? "").trim();
    if (command.length === 0 || !recorded.some((entry) => mentionsCommand(command, entry))) continue;
    out.push({ pid, command, cwd: workingDirectory(pid) });
  }
  return out;
}

function workingDirectory(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    /* not Linux */
  }
  try {
    const found = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { encoding: "utf8" })
      .split("\n")
      .map((line) => (line.startsWith("n") ? line.slice(1) : ""))
      .find((path) => path.startsWith("/"));
    return found ?? null;
  } catch {
    return null;
  }
}

const canonical = selectCanonical(records);
const commands = [
  ...new Set(
    canonical.flatMap((entry) =>
      (Array.isArray(entry.record.commands) ? entry.record.commands : []).flatMap((command) =>
        command !== null &&
        typeof command === "object" &&
        typeof (command as Record<string, unknown>).command === "string"
          ? [(command as Record<string, unknown>).command as string]
          : [],
      ),
    ),
  ),
];
const runners = matchLiveRunners(liveProcesses(commands), commands, root);
const live = runners.attributed;
const verdict = verifyTrail({
  schema,
  order,
  records: canonical,
  artifactExists: onDisk,
  committed,
  liveRunners: live,
});

if (process.argv.includes("--json"))
  console.log(
    JSON.stringify(
      {
        trail,
        rev,
        planned: order.length,
        canonical: canonical.length,
        superseded: records.length - canonical.length,
        unattributedRunners: runners.unattributed,
        unreadGenerations: [...unread].sort(),
        ...verdict,
      },
      null,
      2,
    ),
  );
else {
  console.log(
    `trail=${trail} rev=${rev} planned=${order.length} canonical=${canonical.length} superseded=${records.length - canonical.length} liveRunners=${live.length} unattributedRunners=${runners.unattributed} unreadGenerations=${unread.size}`,
  );
  for (const issue of verdict.issues) console.log(`  ${issue.kind} ${issue.taskId ?? "-"}: ${issue.detail}`);
  console.log(
    `${verdict.ok ? "VERIFIED" : "NOT VERIFIED"}: ${verdict.issues.length} issue(s) across ${verdict.records} record(s)`,
  );
}
process.exit(verdict.ok ? 0 : 1);
