/**
 * Herdr CLI client (herdr spec 03).
 *
 * Herdr is an EXTERNAL dependency. This module is the only place Pi-Engineering
 * shells out to the `herdr` CLI over the socket API. It is NOT a fork or
 * reimplementation — it is a thin, testable consumer of Herdr's documented
 * automation surface (`herdr api schema`, protocol 22).
 *
 * `HerdrCli` is an interface so unit/contract tests inject a fake executable;
 * `RealHerdrCli` shells out to the real `herdr` binary. All structured Herdr
 * errors (`{code, message}`) are normalized to `HerdrError`.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/** Normalized view of a Herdr agent (schema: AgentStatus + AgentTarget fields). */
export interface HerdrAgent {
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown";
  cwd: string;
  pane_id: string;
  workspace_id: string;
  tab_id?: string;
  revision: number;
  state_change_seq: number;
  terminal_title?: string;
}

/** Normalized Herdr error. */
export class HerdrError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "HerdrError";
    this.code = code;
  }
}

export interface HerdrStatus {
  ok: boolean;
  serverVersion: string;
  protocol: number;
}

export interface HerdrWorkspace {
  workspaceId: string;
  paneId: string;
  path: string;
}

/** Thin contract over the Herdr CLI. */
export interface HerdrCli {
  status(): Promise<HerdrStatus>;
  listAgents(): Promise<HerdrAgent[]>;
  getAgent(target: string): Promise<HerdrAgent | null>;
  readAgent(target: string, lines?: number): Promise<string>;
  /** Submit a prompt to a persistent agent (sendTask). */
  prompt(target: string, text: string, timeoutMs?: number): Promise<void>;
  /** Wait until the agent reaches one of `until` states or times out. */
  wait(target: string, until: string[], timeoutMs?: number): Promise<HerdrAgent>;
  startAgent(paneId: string, kind: string, name: string): Promise<void>;
  /** Export environment variables into a pane's shell (before an agent starts there). Optional: older clients lack it. */
  exportEnv?(paneId: string, vars: Record<string, string>): Promise<void>;
  sendKeys(target: string, keys: string): Promise<void>;
  closePane(target: string): Promise<void>;
  /** Create a workspace with a new shell pane in the requested directory. */
  createWorkspace(cwd: string): Promise<HerdrWorkspace>;
  /** Create a Git worktree-backed workspace with its root shell pane. */
  createWorktree(repo: string): Promise<HerdrWorkspace>;
}

export interface RealHerdrCliOptions {
  /** Path to the herdr binary. */
  bin?: string;
  /** Timeout for each CLI invocation. */
  timeoutMs?: number;
}

/** Real client: shells out to the `herdr` CLI. */
export class RealHerdrCli implements HerdrCli {
  private readonly bin: string;
  private readonly timeoutMs: number;

  constructor(opts: RealHerdrCliOptions = {}) {
    this.bin = opts.bin ?? "herdr";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  private async run(args: string[], timeoutMs = this.timeoutMs): Promise<string> {
    try {
      const { stdout } = await exec(this.bin, args, {
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env },
      });
      return stdout.trim();
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
      // Herdr returns JSON errors on stdout with a non-zero exit for API methods.
      const raw = e.stdout ?? e.stderr ?? e.message ?? "";
      const trimmed = raw.trim();
      if (trimmed.startsWith("{")) {
        try {
          const parsed = JSON.parse(trimmed) as { error?: { code?: string; message?: string } };
          if (parsed.error?.code) throw new HerdrError(parsed.error.code, parsed.error.message ?? trimmed);
        } catch {
          if (err instanceof HerdrError) throw err;
        }
      }
      throw new HerdrError("herdr_cli_error", trimmed || String(err));
    }
  }

  async status(): Promise<HerdrStatus> {
    const out = await this.run(["status"]);
    const server = out.match(/version:\s*(\S+)/);
    const protocol = out.match(/protocol:\s*(\d+)/);
    return { ok: true, serverVersion: server?.[1] ?? "unknown", protocol: protocol ? Number(protocol[1]) : 0 };
  }

  async listAgents(): Promise<HerdrAgent[]> {
    const out = await this.run(["agent", "list"]);
    const parsed = JSON.parse(out) as { result?: { agents?: HerdrAgent[] } };
    return parsed.result?.agents ?? [];
  }

  async getAgent(target: string): Promise<HerdrAgent | null> {
    const out = await this.run(["agent", "get", target]);
    const parsed = JSON.parse(out) as { result?: { agent?: HerdrAgent }; error?: { code?: string } };
    if (parsed.error) return null;
    return parsed.result?.agent ?? null;
  }

  async readAgent(target: string, lines?: number): Promise<string> {
    const args = ["agent", "read", target];
    if (lines && lines > 0) args.push("--lines", String(lines));
    return this.run(args);
  }

  async prompt(target: string, text: string, timeoutMs?: number): Promise<void> {
    const deadline = timeoutMs === undefined ? this.timeoutMs : timeoutMs > 0 ? timeoutMs + 1000 : 0;
    await this.run(["agent", "prompt", target, text], deadline);
  }

  async wait(target: string, until: string[], timeoutMs?: number): Promise<HerdrAgent> {
    // herdr 0.9.1: --until repeats per state, and the timeout flag is --timeout (milliseconds)
    const args = ["agent", "wait", target, ...until.flatMap((u) => ["--until", u])];
    if (timeoutMs && timeoutMs > 0) args.push("--timeout", String(timeoutMs));
    // The child must outlive the requested server wait; omitted/zero means an indefinite wait.
    const out = await this.run(args, timeoutMs && timeoutMs > 0 ? timeoutMs + 1000 : 0);
    const parsed = JSON.parse(out) as { result?: { agent?: HerdrAgent } };
    if (!parsed.result?.agent) throw new HerdrError("agent_wait_no_result", "agent.wait returned no agent");
    return parsed.result.agent;
  }

  async exportEnv(paneId: string, vars: Record<string, string>): Promise<void> {
    const safe = /^[A-Za-z0-9._:@/-]{1,128}$/;
    const parts = Object.entries(vars).map(([k, v]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(k) || !safe.test(v)) throw new Error(`refusing to export unsafe value for ${k}`);
      return `${k}=${v}`;
    });
    if (parts.length) await this.run(["pane", "run", paneId, `export ${parts.join(" ")}`]);
  }

  async startAgent(paneId: string, kind: string, name: string): Promise<void> {
    // herdr 0.9.1: the name is positional and the pane flag is --pane
    await this.run(["agent", "start", name, "--kind", kind, "--pane", paneId]);
  }

  async sendKeys(target: string, keys: string): Promise<void> {
    await this.run(["agent", "send-keys", target, keys]);
  }

  async closePane(target: string): Promise<void> {
    await this.run(["pane", "close", target]);
  }

  async createWorkspace(cwd: string): Promise<HerdrWorkspace> {
    return this.parseWorkspace(await this.run(["workspace", "create", "--cwd", cwd, "--no-focus"]), false);
  }

  async createWorktree(repo: string): Promise<HerdrWorkspace> {
    return this.parseWorkspace(await this.run(["worktree", "create", "--cwd", repo, "--no-focus"]), true);
  }

  private parseWorkspace(out: string, worktree: boolean): HerdrWorkspace {
    const parsed = JSON.parse(out) as {
      result?: {
        workspace?: { workspace_id?: string };
        root_pane?: { pane_id?: string; cwd?: string };
        worktree?: { path?: string };
      };
    };
    const workspaceId = parsed.result?.workspace?.workspace_id;
    const paneId = parsed.result?.root_pane?.pane_id;
    const path = worktree ? parsed.result?.worktree?.path : parsed.result?.root_pane?.cwd;
    if (![workspaceId, paneId, path].every((value) => typeof value === "string" && value.length > 0)) {
      throw new HerdrError(
        "herdr_provisioning_invalid",
        "Herdr creation response is missing workspace, root pane or path",
      );
    }
    return { workspaceId: workspaceId!, paneId: paneId!, path: path! };
  }
}
