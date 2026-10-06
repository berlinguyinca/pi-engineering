/**
 * Spawn real Pi Engineering sessions (child processes running
 * `runtimeChild.ts`) and collect their JSON reports.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const CHILD = fileURLToPath(new URL("./runtimeChild.ts", import.meta.url));

export interface ChildReport {
  ok: boolean;
  action?: string;
  pid: number;
  sessionId?: string;
  missionId?: string;
  worktreeId?: string | null;
  bindingKind?: string | null;
  eventsDir?: string | null;
  visibleMissions?: string[];
  error?: string;
}

export interface RunningChild {
  child: ChildProcess;
  /** Resolves with the first report line. */
  report: Promise<ChildReport>;
  /** Resolves when the process exits. */
  exited: Promise<number | null>;
}

export function startChild(
  action: "open" | "hold",
  cwd: string,
  stateDir: string,
  options: { startAt?: number; env?: NodeJS.ProcessEnv } = {},
): RunningChild {
  const args = [CHILD, action, cwd, ...(options.startAt ? [String(options.startAt)] : [])];
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PI_ENGINEERING_STATE_DIR: stateDir };
  delete env.PI_ENGINEERING_ORCHESTRATION_DIR;
  if (options.env?.PI_ENGINEERING_ORCHESTRATION_DIR) {
    env.PI_ENGINEERING_ORCHESTRATION_DIR = options.env.PI_ENGINEERING_ORCHESTRATION_DIR;
  }
  const child = spawn(process.execPath, ["--no-warnings", ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const report = new Promise<ChildReport>((resolve, reject) => {
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      const newline = stdout.indexOf("\n");
      if (newline >= 0) {
        try {
          resolve(JSON.parse(stdout.slice(0, newline)) as ChildReport);
        } catch (error) {
          reject(error);
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      if (!stdout.includes("\n")) {
        reject(new Error(`child ${child.pid} exited (${code ?? signal}) without a report: ${stderr.slice(-2000)}`));
      }
    });
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, report, exited };
}

export async function runChildren(
  count: number,
  cwdFor: (index: number) => string,
  stateDir: string,
  action: "open" | "hold" = "open",
): Promise<{ reports: ChildReport[]; children: RunningChild[] }> {
  // Every child waits for the same instant so initialization truly overlaps.
  const startAt = Date.now() + 1_500;
  const children = Array.from({ length: count }, (_, index) =>
    startChild(action, cwdFor(index), stateDir, { startAt }),
  );
  const reports = await Promise.all(children.map((running) => running.report));
  return { reports, children };
}

export async function makeStateDir(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `pi-eng-${label}-`));
}

/** A real git repository with one commit. */
export async function makeGitRepo(root: string): Promise<string> {
  await mkdir(root, { recursive: true });
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);
  await writeFile(join(root, "README.md"), `# ${root}\n`);
  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-q", "-m", "init"]);
  return root;
}

/** Add a linked worktree of `repo` at `path` on a new branch. */
export async function addWorktree(repo: string, path: string, branch: string): Promise<string> {
  await exec("git", ["-C", repo, "worktree", "add", "-q", "-b", branch, path]);
  return path;
}
