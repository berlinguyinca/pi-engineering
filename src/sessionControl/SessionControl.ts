/** Same-user, same-host status channel for one live PI process instance. */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { type Server, type Socket, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redactSecrets } from "../platform/redact.ts";

const VERSION = 1;
const MAX_REQUEST_BYTES = 8192;
const MAX_RESPONSE_BYTES = 65536;
const NOTE_BYTES = 1024;
const HEARTBEAT_MS = 10000;
const SOCKET_TIMEOUT_MS = 2000;

export interface SessionDescriptor {
  version: 1;
  instanceId: string;
  sessionId: string;
  cwd: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  socketPath: string;
}

export interface MissionBrief {
  id: string;
  status: string;
  health: string | null;
  lastHeartbeatAt: string | null;
  lastMeaningfulProgressAt: string | null;
  tasks: Array<{ id: string; status: string }>;
  lastError: string | null;
}

export interface SessionStatus {
  instanceId: string;
  sessionId: string;
  cwd: string;
  pid: number;
  respondedAt: string;
  processHeartbeatAt: string;
  currentTool: string | null;
  toolStartedAt: string | null;
  lastToolProgressAt: string | null;
  lastToolProgress: string | null;
  snapshotAt: string | null;
  missionSource: "runtime" | "repo_snapshot" | "none";
  missionIds: string[];
  missions: MissionBrief[];
  nonce?: string;
  delivered?: boolean;
}

export type ControlRequest =
  | { version: 1; op: "ping"; nonce: string }
  | { version: 1; op: "status" }
  | { version: 1; op: "note"; messageId: string; text: string };
export type ControlReply = { version: 1; ok: true; data: SessionStatus } | { version: 1; ok: false; error: string };
export interface SessionQueryResult {
  descriptor: SessionDescriptor;
  reachable: boolean;
  reply?: ControlReply;
  error?: string;
}

export interface StartSessionControlOptions {
  rootDir?: string;
  cwd: string;
  sessionId: string;
  onNote?: (text: string) => void | Promise<void>;
  getMissions?: (missionIds: readonly string[]) => Promise<MissionBrief[] | null>;
}

export function sessionControlRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PI_ENGINEERING_CONTROL_DIR) return resolve(env.PI_ENGINEERING_CONTROL_DIR);
  const base = env.XDG_RUNTIME_DIR || tmpdir();
  return join(base, env.XDG_RUNTIME_DIR ? "pi-engineering" : `pi-engineering-${process.getuid?.() ?? "user"}`);
}

async function privateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("control directory must be a real directory, not a symlink");
  if ((info.mode & 0o777) !== 0o700) throw new Error("control directory must have mode 0700");
  if (process.getuid && info.uid !== process.getuid())
    throw new Error("control directory owner differs from this user");
}

async function writeDescriptor(path: string, value: SessionDescriptor): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

async function missionBriefs(cwd: string): Promise<{ snapshotAt: string | null; missions: MissionBrief[] }> {
  try {
    const path = join(cwd, ".pi-eng", "orchestration-snapshot.json");
    const file = await stat(path);
    if (file.size > 4 * 1024 * 1024) return { snapshotAt: null, missions: [] };
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    const missions = Array.isArray(raw.missions) ? raw.missions.slice(-20) : [];
    return {
      snapshotAt: typeof raw.generatedAt === "string" ? raw.generatedAt : null,
      missions: missions
        .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
        .map((m) => {
          const observability =
            m.observability && typeof m.observability === "object" ? (m.observability as Record<string, unknown>) : {};
          const tasks = Array.isArray(m.tasks) ? m.tasks.slice(-40) : [];
          const errors = Array.isArray(observability.errors) ? observability.errors : [];
          const latest = errors.at(-1);
          const summary = latest && typeof latest === "object" ? (latest as Record<string, unknown>).example : null;
          return {
            id: String(m.id ?? ""),
            status: String(m.status ?? "unknown"),
            health: typeof observability.health === "string" ? observability.health : null,
            lastHeartbeatAt: typeof observability.lastHeartbeatAt === "string" ? observability.lastHeartbeatAt : null,
            lastMeaningfulProgressAt:
              typeof observability.lastMeaningfulProgressAt === "string"
                ? observability.lastMeaningfulProgressAt
                : null,
            tasks: tasks
              .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
              .map((t) => ({ id: String(t.id ?? ""), status: String(t.status ?? "unknown") })),
            lastError: typeof summary === "string" ? redactSecrets(summary).slice(0, 200) : null,
          };
        }),
    };
  } catch {
    return { snapshotAt: null, missions: [] };
  }
}

function failure(error: string): ControlReply {
  return { version: VERSION, ok: false, error };
}

function hasUnsafeTerminalControl(text: string): boolean {
  return [...text].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10) || code === 127;
  });
}

export class SessionControlServer {
  readonly instanceId: string;
  readonly descriptorPath: string;
  readonly socketPath: string;
  readonly descriptor: SessionDescriptor;
  private readonly server: Server;
  private readonly onNote?: (text: string) => void | Promise<void>;
  private readonly getMissions?: (missionIds: readonly string[]) => Promise<MissionBrief[] | null>;
  private readonly noteIds = new Set<string>();
  private readonly sockets = new Set<Socket>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private update: Promise<void> = Promise.resolve();
  private closed = false;
  private currentTool: string | null = null;
  private toolStartedAt: string | null = null;
  private lastToolProgressAt: string | null = null;
  private lastToolProgress: string | null = null;
  private readonly activeTools = new Map<string, { name: string; startedAt: string }>();
  private readonly recentMissionIds: string[] = [];

  private constructor(
    rootDir: string,
    cwd: string,
    sessionId: string,
    server: Server,
    onNote?: (text: string) => void | Promise<void>,
    getMissions?: (missionIds: readonly string[]) => Promise<MissionBrief[] | null>,
  ) {
    this.instanceId = randomUUID();
    this.descriptorPath = join(rootDir, `${this.instanceId}.json`);
    this.socketPath = join(rootDir, `${this.instanceId}.sock`);
    this.server = server;
    this.onNote = onNote;
    this.getMissions = getMissions;
    const now = new Date().toISOString();
    this.descriptor = {
      version: VERSION,
      instanceId: this.instanceId,
      sessionId,
      cwd,
      pid: process.pid,
      startedAt: now,
      heartbeatAt: now,
      socketPath: this.socketPath,
    };
  }

  static async start(options: StartSessionControlOptions & { rootDir: string }): Promise<SessionControlServer> {
    await privateDirectory(options.rootDir);
    const server = createServer();
    const control = new SessionControlServer(
      options.rootDir,
      options.cwd,
      options.sessionId,
      server,
      options.onNote,
      options.getMissions,
    );
    if (Buffer.byteLength(control.socketPath) > 100) throw new Error("control socket path exceeds Unix socket limit");
    server.on("connection", (socket) => control.handle(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(control.socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      await chmod(control.socketPath, 0o600);
      await writeDescriptor(control.descriptorPath, control.descriptor);
      control.timer = setInterval(() => {
        if (control.closed) return;
        control.descriptor.heartbeatAt = new Date().toISOString();
        control.update = control.update
          .then(() => writeDescriptor(control.descriptorPath, control.descriptor))
          .catch(() => {});
      }, HEARTBEAT_MS);
      control.timer.unref();
      server.unref();
      return control;
    } catch (error) {
      if (server.listening) server.close();
      await unlink(control.socketPath).catch(() => {});
      throw error;
    }
  }

  toolStarted(name: string, id = name): void {
    const startedAt = new Date().toISOString();
    this.activeTools.set(id, { name: name.slice(0, 80), startedAt });
    this.currentTool = name.slice(0, 80);
    this.toolStartedAt = startedAt;
    this.lastToolProgressAt = this.toolStartedAt;
    this.lastToolProgress = null;
  }

  toolUpdated(name: string, summary?: string, id = name): void {
    if (this.activeTools.get(id)?.name !== name) return;
    this.lastToolProgressAt = new Date().toISOString();
    if (summary) {
      this.lastToolProgress = redactSecrets(summary).slice(0, 200);
      if (name === "mission") this.missionProgress(summary);
    }
  }

  missionProgress(line: string): void {
    const missionId = /\[mission (MSN-[A-Za-z0-9_-]+)\]/.exec(line)?.[1];
    if (!missionId || this.recentMissionIds.includes(missionId)) return;
    this.recentMissionIds.push(missionId);
    if (this.recentMissionIds.length > 5) this.recentMissionIds.shift();
  }

  toolEnded(name: string, id = name): void {
    if (this.activeTools.get(id)?.name !== name) return;
    this.activeTools.delete(id);
    const current = [...this.activeTools.values()].at(-1);
    this.currentTool = current?.name ?? null;
    this.toolStartedAt = current?.startedAt ?? null;
    this.lastToolProgressAt = new Date().toISOString();
  }

  private async status(includeMissions = true): Promise<SessionStatus> {
    let snapshotAt: string | null = null;
    let missions: MissionBrief[] = [];
    let missionSource: SessionStatus["missionSource"] = "none";
    if (includeMissions && this.recentMissionIds.length) {
      const runtime = await this.getMissions?.([...this.recentMissionIds]).catch(() => null);
      if (runtime) {
        missions = runtime;
        missionSource = "runtime";
      } else {
        const snapshot = await missionBriefs(this.descriptor.cwd);
        snapshotAt = snapshot.snapshotAt;
        missions = snapshot.missions;
        missionSource = snapshotAt ? "repo_snapshot" : "none";
      }
    }
    return {
      instanceId: this.instanceId,
      sessionId: this.descriptor.sessionId,
      cwd: this.descriptor.cwd,
      pid: process.pid,
      respondedAt: new Date().toISOString(),
      processHeartbeatAt: this.descriptor.heartbeatAt,
      currentTool: this.currentTool,
      toolStartedAt: this.toolStartedAt,
      lastToolProgressAt: this.lastToolProgressAt,
      lastToolProgress: this.lastToolProgress,
      snapshotAt,
      missionSource,
      missionIds: [...this.recentMissionIds],
      missions: missions.filter((mission) => this.recentMissionIds.includes(mission.id)),
    };
  }

  private async reply(input: unknown): Promise<ControlReply> {
    if (this.closed) return failure("session_closing");
    if (!input || typeof input !== "object") return failure("invalid_request");
    const request = input as Record<string, unknown>;
    if (request.version !== VERSION) return failure("unsupported_version");
    if (request.op === "ping") {
      if (typeof request.nonce !== "string" || request.nonce.length < 1 || request.nonce.length > 128)
        return failure("invalid_nonce");
      return { version: VERSION, ok: true, data: { ...(await this.status(false)), nonce: request.nonce } };
    }
    if (request.op === "status") return { version: VERSION, ok: true, data: await this.status() };
    if (request.op !== "note") return failure("unknown_operation");
    if (typeof request.messageId !== "string" || !/^[0-9a-f-]{36}$/.test(request.messageId))
      return failure("invalid_message_id");
    if (
      typeof request.text !== "string" ||
      !request.text.trim() ||
      Buffer.byteLength(request.text) > NOTE_BYTES ||
      hasUnsafeTerminalControl(request.text)
    )
      return failure("invalid_note");
    if (!this.onNote) return failure("notes_unavailable");
    if (!this.noteIds.has(request.messageId)) {
      try {
        await this.onNote(request.text);
      } catch {
        return failure("delivery_failed");
      }
      this.noteIds.add(request.messageId);
      if (this.noteIds.size > 128) this.noteIds.delete(this.noteIds.values().next().value!);
    }
    return { version: VERSION, ok: true, data: { ...(await this.status()), delivered: true } };
  }

  private handle(socket: Socket): void {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    let body = "";
    let done = false;
    const respond = (reply: ControlReply) => {
      if (done) return;
      done = true;
      socket.end(`${JSON.stringify(reply)}\n`, () => socket.destroy());
    };
    const deadline = setTimeout(() => respond(failure("request_timeout")), SOCKET_TIMEOUT_MS);
    deadline.unref();
    socket.once("close", () => {
      clearTimeout(deadline);
      this.sockets.delete(socket);
    });
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      if (done) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return respond(failure("request_too_large"));
      const newline = body.indexOf("\n");
      if (newline === -1) return;
      if (body.slice(newline + 1).trim()) return respond(failure("multiple_requests"));
      let request: unknown;
      try {
        request = JSON.parse(body.slice(0, newline));
      } catch {
        return respond(failure("invalid_json"));
      }
      void this.reply(request).then(respond, () => respond(failure("internal_error")));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    await this.update;
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await unlink(this.socketPath).catch(() => {});
    try {
      const existing = JSON.parse(await readFile(this.descriptorPath, "utf8"));
      if (existing.instanceId === this.instanceId) await unlink(this.descriptorPath);
    } catch {
      /* A missing or replaced descriptor is not ours to remove. */
    }
  }
}

export async function startSessionControl(options: StartSessionControlOptions): Promise<SessionControlServer> {
  return SessionControlServer.start({ ...options, rootDir: options.rootDir ?? sessionControlRoot() });
}

export async function discoverSessions(rootDir = sessionControlRoot()): Promise<SessionDescriptor[]> {
  let names: string[];
  try {
    names = await readdir(rootDir);
  } catch {
    return [];
  }
  const found: SessionDescriptor[] = [];
  for (const name of names.filter((n) => /^[0-9a-f-]{36}\.json$/.test(n))) {
    try {
      const path = join(rootDir, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > 4096) continue;
      const d = JSON.parse(await readFile(path, "utf8")) as SessionDescriptor;
      if (
        d.version !== VERSION ||
        d.instanceId !== name.slice(0, -5) ||
        d.socketPath !== join(rootDir, `${d.instanceId}.sock`) ||
        typeof d.sessionId !== "string" ||
        typeof d.cwd !== "string" ||
        !Number.isInteger(d.pid) ||
        typeof d.heartbeatAt !== "string"
      )
        continue;
      found.push(d);
    } catch {
      /* A session may be replacing its descriptor concurrently. */
    }
  }
  return found.sort((a, b) => a.instanceId.localeCompare(b.instanceId));
}

export async function requestSession(
  descriptor: SessionDescriptor,
  request: ControlRequest,
  timeoutMs = 1500,
): Promise<ControlReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(descriptor.socketPath);
    socket.setEncoding("utf8");
    let body = "";
    let settled = false;
    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        reject(error);
      }
    };
    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => fail(new Error("session_unresponsive")));
    socket.on("error", fail);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      if (settled) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) return fail(new Error("response_too_large"));
      const newline = body.indexOf("\n");
      if (newline === -1) return;
      try {
        const reply = JSON.parse(body.slice(0, newline)) as ControlReply;
        if (reply.version !== VERSION || typeof reply.ok !== "boolean") return fail(new Error("invalid_reply"));
        if (reply.ok && (!reply.data || reply.data.instanceId !== descriptor.instanceId))
          return fail(new Error("session_identity_mismatch"));
        settled = true;
        socket.end();
        resolve(reply);
      } catch {
        fail(new Error("invalid_reply"));
      }
    });
    socket.on("end", () => {
      if (!settled) fail(new Error("incomplete_reply"));
    });
  });
}

export async function queryAllSessions(
  rootDir = sessionControlRoot(),
  options: { concurrency?: number; timeoutMs?: number; fullStatus?: boolean } = {},
): Promise<SessionQueryResult[]> {
  const descriptors = await discoverSessions(rootDir);
  const results: SessionQueryResult[] = new Array(descriptors.length);
  const concurrency = Math.max(1, Math.min(32, Math.floor(options.concurrency ?? 8)));
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, descriptors.length) }, async () => {
      while (next < descriptors.length) {
        const index = next++;
        const descriptor = descriptors[index]!;
        try {
          const nonce = randomUUID();
          const reply = await requestSession(
            descriptor,
            options.fullStatus ? { version: VERSION, op: "status" } : { version: VERSION, op: "ping", nonce },
            options.timeoutMs ?? 1500,
          );
          const reachable =
            reply.ok &&
            (options.fullStatus || reply.data.nonce === nonce) &&
            reply.data.instanceId === descriptor.instanceId;
          results[index] = {
            descriptor,
            reachable,
            reply,
            ...(!reachable ? { error: "invalid_session_response" } : {}),
          };
        } catch (error) {
          results[index] = {
            descriptor,
            reachable: false,
            error: error instanceof Error ? error.message : "unreachable",
          };
        }
      }
    }),
  );
  return results;
}
