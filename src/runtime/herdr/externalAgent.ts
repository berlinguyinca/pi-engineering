/**
 * Pi as an EXTERNAL coworker agent in someone else's Herdr room (Herdr's T10 protocol, docs/operations/external-agents.md).
 *
 * Outbound only. A room owner gives the coworker a one-time join code; `pi-engineering herdr join` redeems it
 * (`POST /api/v1/collab/agents/join`) and stores the resulting credential, 0600, in Pi's state directory. From then on
 * a running Pi heartbeats (`/agents/external/heartbeat`, at least every 60 s) and may report lineage ABOUT ITSELF
 * (`/agents/external/lineage`: agent/attempt/session nodes and spawn edges; Herdr refuses anything else).
 *
 * Where the control plane lives comes from the global YAML `herdr.url` (no environment variables). No credential file,
 * no `herdr.url`: nothing starts and nothing connects. The join code is read from a file or stdin, never argv; the
 * credential is never logged, put in an error message or sent anywhere except the `Authorization` header to `herdr.url`.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadHerdrConnection } from "./herdrConnection.ts";

export const EXTERNAL_STATE_FILE = "herdr-external.json";
const COLLAB = "/api/v1/collab";
const HEARTBEAT_MS = 45_000;
const REQUEST_TIMEOUT_MS = 8_000;

export type ExternalStatus = "idle" | "working" | "waiting" | "blocked" | "done" | "failed";

export interface ExternalCredential {
  baseUrl: string;
  agentId: string;
  credential: string;
  deviceId: string;
  roomId?: string;
  expiresAt?: string;
  /** Next lineage `source_sequence` to use (advanced only after Herdr accepted the event). */
  nextSequence: number;
}

export class ExternalAgentError extends Error {
  readonly status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = "ExternalAgentError";
    this.status = status;
  }
}

export interface ExternalAgentDeps {
  fetch?: typeof globalThis.fetch;
}

const stateFile = (stateDir: string) => join(stateDir, EXTERNAL_STATE_FILE);

function save(stateDir: string, cred: ExternalCredential): void {
  const file = stateFile(stateDir);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cred), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

const MAX_STATE_FILE = 4096;

/**
 * The stored credential, or null. The file must be a regular file (not a link), owned by the current user, not
 * readable by group or others, and small: the same rules as the Herdr key file. A file that breaks any of them is no
 * credential, so a planted or world-readable one is never used.
 */
export function loadExternalCredential(stateDir: string): ExternalCredential | null {
  const file = stateFile(stateDir);
  if (!existsSync(file)) return null;
  try {
    const st = lstatSync(file);
    if (!st.isFile() || (st.mode & 0o077) !== 0 || st.size > MAX_STATE_FILE) return null;
    if (typeof process.getuid === "function" && st.uid !== process.getuid()) return null;
    const v = JSON.parse(readFileSync(file, "utf8")) as Partial<ExternalCredential>;
    if (
      typeof v.baseUrl === "string" &&
      typeof v.agentId === "string" &&
      typeof v.credential === "string" &&
      typeof v.deviceId === "string"
    )
      return {
        ...(v as ExternalCredential),
        nextSequence: Number.isSafeInteger(v.nextSequence) ? (v.nextSequence as number) : 0,
      };
  } catch {
    // an unreadable state file is no credential
  }
  return null;
}

export class ExternalAgentClient {
  private cred: ExternalCredential;
  private readonly stateDir: string;
  private readonly fetchImpl: typeof globalThis.fetch;

  private constructor(stateDir: string, cred: ExternalCredential, deps: ExternalAgentDeps) {
    this.stateDir = stateDir;
    this.cred = cred;
    this.fetchImpl = deps.fetch ?? globalThis.fetch;
  }

  /**
   * `expectedBaseUrl` is the YAML `herdr.url`. When given, a stored credential for any OTHER url is refused: the
   * credential is only ever sent where the operator's own config says Herdr is, never to a url read from a state file.
   */
  static fromState(
    stateDir: string,
    deps: ExternalAgentDeps = {},
    expectedBaseUrl?: string,
  ): ExternalAgentClient | null {
    const cred = loadExternalCredential(stateDir);
    if (!cred) return null;
    if (expectedBaseUrl !== undefined && cred.baseUrl !== expectedBaseUrl) return null;
    return new ExternalAgentClient(stateDir, cred, deps);
  }

  /** Redeem a one-time join code. The public route: the code is the authentication; nothing else is sent. */
  static async join(
    baseUrl: string,
    code: string,
    stateDir: string,
    deps: ExternalAgentDeps = {},
  ): Promise<ExternalAgentClient> {
    const f = deps.fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await f(`${baseUrl}${COLLAB}/agents/join`, {
        method: "POST",
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: code.trim(), harness_type: "pi" }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ExternalAgentError("could not reach the control plane");
    }
    if (!res.ok) throw new ExternalAgentError(`join refused (HTTP ${res.status})`, res.status);
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (
      !body ||
      typeof body.credential !== "string" ||
      typeof body.device_id !== "string" ||
      typeof body.agent_id !== "string"
    )
      throw new ExternalAgentError("join answered an unexpected body");
    const cred: ExternalCredential = {
      baseUrl,
      agentId: body.agent_id,
      credential: body.credential,
      deviceId: body.device_id,
      ...(typeof body.room_id === "string" ? { roomId: body.room_id } : {}),
      ...(typeof body.expires_at === "string" ? { expiresAt: body.expires_at } : {}),
      nextSequence: 0,
    };
    save(stateDir, cred);
    return new ExternalAgentClient(stateDir, cred, deps);
  }

  get agentId(): string {
    return this.cred.agentId;
  }

  private async call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.cred.baseUrl}${COLLAB}${path}`, {
        method,
        redirect: "error",
        headers: {
          Authorization: `Agent ${this.cred.credential}`,
          "X-Herdr-Device": this.cred.deviceId,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ExternalAgentError("could not reach the control plane");
    }
    if (!res.ok) throw new ExternalAgentError(`${path} refused (HTTP ${res.status})`, res.status);
    return res.json().catch(() => ({}));
  }

  me(): Promise<unknown> {
    return this.call("GET", "/agents/external/me");
  }

  /** Presence. Must be repeated at least every 60 s or Herdr shows the agent as stale after 90 s. */
  heartbeat(status: ExternalStatus, activity: string): Promise<unknown> {
    return this.call("POST", "/agents/external/heartbeat", { status, activity: activity.slice(0, 140) });
  }

  /**
   * One lineage event about this agent itself. Herdr builds the envelope; Pi supplies only the event. The sequence
   * advances (and is persisted) only after Herdr accepted the event, so a failed send is retried with the same id.
   */
  async lineage(eventType: "node.upsert" | "node.state", payload: Record<string, unknown>): Promise<void> {
    const seq = this.cred.nextSequence;
    await this.call("POST", "/agents/external/lineage", {
      event_id: `pi-${this.cred.agentId}-${seq}`,
      source_sequence: seq,
      event_type: eventType,
      payload,
    });
    this.cred = { ...this.cred, nextSequence: seq + 1 };
    save(this.stateDir, this.cred);
  }

  /** Report this agent's own node (`agent:<id>`) with a state. */
  reportSelf(state: "running" | "done" | "failed" | "blocked", label?: string): Promise<void> {
    const node = `agent:${this.cred.agentId}`;
    return this.lineage("node.upsert", {
      node_type: "agent",
      node_id: node,
      state,
      ...(label ? { label: label.slice(0, 120) } : {}),
    });
  }

  /** Withdraw from the room and forget the credential. */
  async leave(): Promise<void> {
    await this.call("POST", "/agents/external/leave", {});
    try {
      writeFileSync(stateFile(this.stateDir), "{}", { mode: 0o600 });
    } catch {
      // best effort
    }
  }
}

export interface ExternalBridge {
  client: ExternalAgentClient;
  stop(): void;
}

/**
 * Start heartbeating when (and only when) a credential exists AND the global YAML has `herdr.url`. Null otherwise: no
 * network, no timer. The first heartbeat is sent at once; a refusal (revoked, expired) stops the loop.
 */
export async function startExternalBridge(input: {
  agentDir: string;
  stateDir: string;
  fetch?: typeof globalThis.fetch;
  status?: () => { status: ExternalStatus; activity: string };
  intervalMs?: number;
  log?: (line: string) => void;
}): Promise<ExternalBridge | null> {
  const { connection } = await loadHerdrConnection(input.agentDir);
  if (!connection) return null;
  const client = ExternalAgentClient.fromState(
    input.stateDir,
    input.fetch ? { fetch: input.fetch } : {},
    connection.baseUrl,
  );
  if (!client) return null;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const beat = async (): Promise<void> => {
    if (stopped) return;
    const s = input.status?.() ?? { status: "idle" as const, activity: "pi" };
    try {
      await client.heartbeat(s.status, s.activity);
    } catch (err) {
      if (err instanceof ExternalAgentError && (err.status === 401 || err.status === 403)) {
        stopped = true;
        input.log?.("[herdr] external agent credential refused; heartbeat stopped");
        return;
      }
    }
    if (!stopped) {
      timer = setTimeout(() => void beat(), input.intervalMs ?? HEARTBEAT_MS);
      timer.unref?.();
    }
  };
  void beat();
  return {
    client,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
