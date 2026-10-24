/**
 * Real Herdr control-plane process for Pi-side acceptance tests (T16).
 *
 * Mirrors herdr tests/e2e/harness.py: `python3 -m herdr_engineering.cli control-plane web` on loopback, configured ONLY
 * through a generated 0600 fleet-config YAML (JSON is valid YAML) and a generated collaboration users file. Keys and
 * tokens are generated at run time. Suite paths come from test/e2e/acceptance.yaml, never from environment variables.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readYaml } from "../../../src/lifecycle/policy.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
export const PI_ROOT = resolve(HERE, "../../..");

export interface Acceptance {
  herdrRepo: string;
  autospecBin: string;
  python: string;
  startupSeconds: number;
}

export async function loadAcceptance(): Promise<Acceptance> {
  const dir = join(PI_ROOT, "test/e2e");
  const local = join(dir, "acceptance.local.yaml");
  let raw = (await readYaml(local)).raw as Record<string, unknown> | undefined;
  raw ??= (await readYaml(join(dir, "acceptance.yaml"))).raw as Record<string, unknown>;
  if (!raw || raw.version !== 1) throw new Error("acceptance config must have version: 1");
  const abs = (v: unknown) => (isAbsolute(String(v)) ? String(v) : resolve(PI_ROOT, String(v)));
  return {
    herdrRepo: abs(raw.herdr_repo),
    autospecBin: abs(raw.autospec_bin),
    python: String(raw.python ?? "python3"),
    startupSeconds: Number(raw.startup_timeout_seconds ?? 30),
  };
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
export const principalId = (key: string) => `key:${sha256(key).slice(0, 12)}`;
export const newSecret = (label: string) => `e2e-${label}-${randomBytes(16).toString("hex")}`;
export const sha40 = (seed: string) => sha256(`e2e-commit:${seed}`).slice(0, 40);

export async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => res(port));
    });
    s.on("error", rej);
  });
}

export interface PlaneOptions {
  name?: string;
  /** label -> role (viewer | ingest | operator); `viewer` and `operator` always exist. */
  keys?: Record<string, string>;
  users?: string[];
  /** label -> {rooms, missions}: control_plane.lineage_key_scopes */
  scopes?: Record<string, { rooms?: string[]; missions?: string[] }>;
  quorum?: unknown;
  collab?: Record<string, unknown>;
  pgDsn?: string;
  workdir?: string;
}

export interface CallOptions {
  body?: unknown;
  key?: string;
  user?: string;
  agent?: { credential: string; device: string };
  headers?: Record<string, string>;
}

export interface Reply {
  status: number;
  body: any;
}

function resolveRefs(node: unknown, keys: Record<string, string>): unknown {
  if (typeof node === "string" && node.startsWith("@")) return principalId(keys[node.slice(1)] as string);
  if (Array.isArray(node)) return node.map((v) => resolveRefs(v, keys));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([k, v]) => [
        String(resolveRefs(k, keys)),
        resolveRefs(v, keys),
      ]),
    );
  }
  return node;
}

export class Plane {
  readonly workdir: string;
  readonly keys: Record<string, string> = {};
  readonly tokens: Record<string, string> = {};
  port = 0;
  proc: ChildProcess | null = null;
  private readonly roles: Record<string, string>;
  private readonly acc: Acceptance;
  private readonly opts: PlaneOptions;

  private constructor(acc: Acceptance, opts: PlaneOptions) {
    this.acc = acc;
    this.opts = opts;
    this.workdir = opts.workdir ?? mkdtempSync(join(tmpdir(), "t16-plane-"));
    mkdirSync(this.workdir, { recursive: true });
    this.roles = { viewer: "viewer", operator: "operator", ...(opts.keys ?? {}) };
    for (const label of Object.keys(this.roles)) this.keys[label] = newSecret(label);
    for (const u of opts.users ?? []) this.tokens[u] = newSecret(`tok-${u}`);
  }

  static async start(opts: PlaneOptions = {}): Promise<Plane> {
    const p = new Plane(await loadAcceptance(), opts);
    await p.start();
    return p;
  }

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  pid(label: string): string {
    return principalId(this.keys[label] as string);
  }

  alive(): boolean {
    return this.proc !== null && this.proc.exitCode === null && this.proc.signalCode === null;
  }

  private writeConfig(): { fleet: string; users: string } {
    const name = this.opts.name ?? "plane";
    const features = {
      delegation_enabled: true,
      steering: { enabled: true },
      contextual: { enabled: true },
      insights: { enabled: true },
    };
    const cp: Record<string, unknown> = {
      api_keys: Object.fromEntries(Object.entries(this.roles).map(([l, r]) => [this.keys[l], r])),
      collab: { ...features, ...(this.opts.collab ?? {}) },
    };
    if (this.opts.scopes) {
      cp.lineage_key_scopes = Object.fromEntries(Object.entries(this.opts.scopes).map(([l, a]) => [this.keys[l], a]));
    }
    if (this.opts.quorum !== undefined) cp.review_quorum = resolveRefs(this.opts.quorum, this.keys);
    if (this.opts.pgDsn) cp.pg_dsn = this.opts.pgDsn;
    const fleet = join(this.workdir, `${name}-fleet.yaml`);
    writeFileSync(
      fleet,
      JSON.stringify({ version: 1, hosts: {}, sections: { control_plane: { roles: ["admin"], values: cp } } }),
    );
    chmodSync(fleet, 0o600);
    const users = join(this.workdir, `${name}-users.json`);
    writeFileSync(
      users,
      JSON.stringify(Object.fromEntries(Object.entries(this.tokens).map(([u, t]) => [u, sha256(t)]))),
    );
    chmodSync(users, 0o600);
    return { fleet, users };
  }

  async start(): Promise<void> {
    const { fleet, users } = this.writeConfig();
    this.port = await freePort();
    const args = [
      "-m",
      "herdr_engineering.cli",
      "control-plane",
      "web",
      "--host",
      "127.0.0.1",
      "--port",
      String(this.port),
      "--fleet-config",
      fleet,
    ];
    if (Object.keys(this.tokens).length) args.push("--collab-users-file", users);
    const log = openSync(join(this.workdir, `${this.opts.name ?? "plane"}.log`), "a");
    this.proc = spawn(this.acc.python, args, {
      cwd: this.acc.herdrRepo,
      stdio: ["ignore", log, log],
      env: { PATH: process.env.PATH ?? "" },
    });
    closeSync(log);
    const deadline = Date.now() + this.acc.startupSeconds * 1000;
    for (;;) {
      if (!this.alive()) throw new Error(`control plane exited during startup:\n${this.tail()}`);
      try {
        if ((await this.call("GET", "/api/v1/ingest/sources", { key: "viewer" })).status === 200) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) {
        await this.stop();
        throw new Error(`control plane did not become ready:\n${this.tail()}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    // only OUR process accepts our random key and refuses a wrong one (guards a recycled port)
    const wrong = await this.call("GET", "/api/v1/ingest/sources", {
      headers: { "x-api-key": `wrong-${randomBytes(4).toString("hex")}` },
    });
    if (wrong.status !== 401) throw new Error("port is served by a different control plane");
  }

  tail(): string {
    try {
      return readFileSync(join(this.workdir, `${this.opts.name ?? "plane"}.log`), "utf8")
        .split("\n")
        .slice(-40)
        .join("\n");
    } catch {
      return "";
    }
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const p = this.proc;
    if (!p || !this.alive()) return;
    await new Promise<void>((res) => {
      p.once("exit", () => res());
      p.kill(signal);
      setTimeout(() => p.kill("SIGKILL"), 8000).unref();
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  headers(o: CallOptions): Record<string, string> {
    const h: Record<string, string> = {};
    if (o.key !== undefined) h["x-api-key"] = this.keys[o.key] ?? o.key;
    if (o.user !== undefined) h.authorization = `Bearer ${this.tokens[o.user] ?? o.user}`;
    if (o.agent) {
      h.authorization = `Agent ${o.agent.credential}`;
      h["x-herdr-device"] = o.agent.device;
    }
    return { ...h, ...(o.headers ?? {}) };
  }

  async call(method: string, path: string, o: CallOptions = {}): Promise<Reply> {
    const h = this.headers(o);
    let body: string | undefined;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      h["content-type"] = "application/json";
    }
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: h,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { _unparsed: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  }

  /** HCN call: path relative to /api/v1/collab */
  c(method: string, path: string, o: CallOptions = {}): Promise<Reply> {
    return this.call(method, `/api/v1/collab${path}`, { ...o, body: o.body ?? (method === "POST" ? {} : undefined) });
  }

  async makeRoom(owner: string, project = "p", room = "r"): Promise<{ projectId: string; roomId: string }> {
    const pj = await this.c("POST", "/projects", { user: owner, body: { name: project } });
    if (pj.status !== 201) throw new Error(`create project: ${JSON.stringify(pj.body)}`);
    const rm = await this.c("POST", `/projects/${pj.body.project_id}/rooms`, { user: owner, body: { name: room } });
    if (rm.status !== 201) throw new Error(`create room: ${JSON.stringify(rm.body)}`);
    return { projectId: pj.body.project_id, roomId: rm.body.room_id };
  }

  async addMember(owner: string, room: string, user: string, role: string): Promise<void> {
    const r = await this.c("POST", `/rooms/${room}/members`, { user: owner, body: { user_id: user, role } });
    if (r.status !== 201) throw new Error(`add member: ${JSON.stringify(r.body)}`);
  }

  /** POSITIVE CONTROL: each optional feature must really be ON (so a 403/404 in a security assertion is authorization). */
  async verifyFeatures(owner: string): Promise<void> {
    const { roomId } = await this.makeRoom(owner, "feature-probe", "feature-probe-room");
    for (const p of ["xlinks", "delegations", "proposals", "consultations"]) {
      const r = await this.c("GET", `/rooms/${roomId}/${p}`, { user: owner });
      if (r.status !== 200 || r.body.enabled !== true)
        throw new Error(`feature probe ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    for (const p of ["attention", "progress", "analytics"]) {
      const r = await this.c("GET", `/rooms/${roomId}/${p}`, { user: owner });
      if (r.status !== 200) throw new Error(`feature probe ${p}: ${r.status} ${JSON.stringify(r.body)}`);
    }
    const st = await this.c("POST", `/rooms/${roomId}/steering`, {
      user: owner,
      body: { node_id: "agent:probe", action: "pause", instruction: "x" },
    });
    if (st.status === 403 || st.body.code === "steering_disabled")
      throw new Error(`feature probe steering: ${JSON.stringify(st.body)}`);
  }

  async node(id: string, key = "operator"): Promise<Reply> {
    return this.call("GET", `/api/v1/graph/nodes/${encodeURIComponent(id)}`, { key });
  }

  async hood(id: string, key = "operator", depth = 2): Promise<Reply> {
    return this.call("GET", `/api/v1/graph/nodes/${encodeURIComponent(id)}/neighborhood?depth=${depth}`, { key });
  }

  async edges(id: string, key = "operator", depth = 1): Promise<Array<[string, string, string]>> {
    const r = await this.hood(id, key, depth);
    return ((r.body.edges ?? []) as Array<{ edge_type: string; from_id: string; to_id: string; removed?: boolean }>)
      .filter((e) => !e.removed)
      .map((e) => [e.edge_type, e.from_id, e.to_id] as [string, string, string])
      .sort();
  }

  async sources(
    key = "viewer",
  ): Promise<Record<string, { source?: string; actor?: string; last_sequence?: number; gaps?: unknown[] }>> {
    const r = await this.call("GET", "/api/v1/ingest/sources", { key });
    return Object.fromEntries((r.body.sources ?? []).map((s: { source: string }) => [s.source, s]));
  }
}

/** Poll until `fn` returns a truthy value (outbox delivery is asynchronous). */
export async function eventually<T>(
  fn: () => Promise<T | false | undefined | null>,
  what: string,
  ms = 15_000,
): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}${last ? `: ${String(last)}` : ""}`);
    await new Promise((r) => setTimeout(r, 120));
  }
}
