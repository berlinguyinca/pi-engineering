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

/** Thin contract over the Herdr CLI. */
export interface HerdrCli {
  status(): Promise<HerdrStatus>;
  listAgents(): Promise<HerdrAgent[]>;
  getAgent(target: string): Promise<HerdrAgent | null>;
  readAgent(target: string, lines?: number): Promise<string>;
  /** Submit a prompt to a persistent agent (sendTask). */
  prompt(target: string, text: string): Promise<void>;
  /** Wait until the agent reaches one of `until` states or times out. */
  wait(target: string, until: string[], timeoutMs?: number): Promise<HerdrAgent>;
  startAgent(paneId: string, kind: string, name: string): Promise<void>;
  sendKeys(target: string, keys: string): Promise<void>;
  closePane(target: string): Promise<void>;
  /** Create a Git worktree-backed workspace; returns its id/path. */
  createWorktree(repo: string): Promise<{ workspaceId: string; path: string }>;
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

  private async run(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec(this.bin, args, {
        timeout: this.timeoutMs,
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
    const parsed = JSON.parse(out) as { result?: HerdrAgent; error?: { code?: string } };
    if (parsed.error) return null;
    return parsed.result ?? null;
  }

  async readAgent(target: string, lines?: number): Promise<string> {
    const args = ["agent", "read", target];
    if (lines && lines > 0) args.push("--lines", String(lines));
    return this.run(args);
  }

  async prompt(target: string, text: string): Promise<void> {
    await this.run(["agent", "prompt", target, text]);
  }

  async wait(target: string, until: string[], timeoutMs?: number): Promise<HerdrAgent> {
    const args = ["agent", "wait", target, "--until", until.join(",")];
    if (timeoutMs && timeoutMs > 0) args.push("--timeout-ms", String(timeoutMs));
    const out = await this.run(args);
    const parsed = JSON.parse(out) as { result?: HerdrAgent };
    if (!parsed.result) throw new HerdrError("agent_wait_no_result", "agent.wait returned no agent");
    return parsed.result;
  }

  async startAgent(paneId: string, kind: string, name: string): Promise<void> {
    await this.run(["agent", "start", "--pane-id", paneId, "--kind", kind, "--name", name]);
  }

  async sendKeys(target: string, keys: string): Promise<void> {
    await this.run(["agent", "send-keys", target, keys]);
  }

  async closePane(target: string): Promise<void> {
    await this.run(["pane", "close", target]);
  }

  async createWorktree(repo: string): Promise<{ workspaceId: string; path: string }> {
    const out = await this.run(["worktree", "create", repo]);
    const parsed = JSON.parse(out) as { result?: { workspace_id?: string; path?: string } };
    return {
      workspaceId: parsed.result?.workspace_id ?? "unknown",
      path: parsed.result?.path ?? repo,
    };
  }
}
