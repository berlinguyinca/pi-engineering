/**
 * Outbound-only poller for Herdr steering requests (T12).
 *
 * Pi connects OUT to the control plane it already reports to, with the same ingest key (Herdr pins a request to the
 * key that reported the target, so a different key receives nothing). It asks `GET /api/v1/steering/pending`, hands
 * each well-formed item to `applySteering` and reports `POST /api/v1/steering/<id>/ack`. Nothing listens, nothing is
 * pushed in, no port is opened, and the key is never logged or placed in an error.
 *
 * OFF unless the GLOBAL engineering YAML says so (`steering.enabled: true`) AND a control plane is configured. Standalone
 * Pi, with or without AutoSpec, never constructs one (see `createSteeringReceiver`).
 */

import { join } from "node:path";
import { readYaml } from "../../lifecycle/policy.ts";
import {
  FileSteeringLedger,
  type SteeringAck,
  type SteeringLedger,
  type SteeringPorts,
  applySteering,
  parseSteeringItems,
} from "../../orchestration/steering.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_INTERVAL_MS = 5_000;
const MIN_INTERVAL_MS = 1_000;
const MAX_INTERVAL_MS = 300_000;

export interface SteeringReceiverOptions {
  /** Control plane base URL (http/https, no credentials, query or fragment). */
  baseUrl: string;
  apiKey?: string;
  ports: SteeringPorts;
  ledger: SteeringLedger;
  fetch?: typeof globalThis.fetch;
  intervalMs?: number;
  timeoutMs?: number;
  /** Short, secret-free diagnostics only. */
  log?: (message: string) => void;
}

export interface PollResult {
  received: number;
  acked: number;
  dropped: number;
  error: string | null;
}

export class SteeringReceiver {
  private readonly base: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private failures = 0;
  private readonly intervalMs: number;
  private readonly opts: SteeringReceiverOptions;

  constructor(opts: SteeringReceiverOptions) {
    this.opts = opts;
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, opts.intervalMs ?? DEFAULT_INTERVAL_MS));
  }

  private headers(): Record<string, string> {
    return { accept: "application/json", ...(this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {}) };
  }

  private async readJson(res: Response): Promise<unknown> {
    const text = await res.text();
    if (text.length > MAX_BODY_BYTES) throw new Error("response too large");
    return text ? JSON.parse(text) : {};
  }

  private async ack(id: string, ack: SteeringAck): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.base}/api/v1/steering/${encodeURIComponent(id)}/ack`, {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ outcome: ack.outcome, note: ack.note }),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  /** One round trip. Never throws; a failed ack is retried on the next poll because Herdr re-offers it. */
  async pollOnce(): Promise<PollResult> {
    const out: PollResult = { received: 0, acked: 0, dropped: 0, error: null };
    let body: unknown;
    try {
      const res = await this.fetchImpl(`${this.base}/api/v1/steering/pending`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 10_000),
      });
      if (!res.ok) {
        out.error = `control plane answered ${res.status}`;
        return out;
      }
      body = await this.readJson(res);
    } catch (err) {
      out.error = (err as Error).name === "TimeoutError" ? "timed out" : "unreachable or unreadable";
      return out;
    }
    const { items, dropped } = parseSteeringItems(body);
    out.received = items.length;
    out.dropped = dropped;
    for (const item of items) {
      const result = await applySteering(item, this.opts.ports, this.opts.ledger);
      if (await this.ack(item.steeringId, result)) out.acked++;
    }
    return out;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async (): Promise<void> => {
      if (!this.running) return;
      const r = await this.pollOnce();
      this.failures = r.error ? Math.min(this.failures + 1, 6) : 0;
      if (r.error) this.opts.log?.(`steering poll: ${r.error}`);
      if (!this.running) return;
      this.timer = setTimeout(tick, Math.min(MAX_INTERVAL_MS, this.intervalMs * 2 ** this.failures));
      this.timer.unref?.();
    };
    this.timer = setTimeout(tick, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

// ─── configuration: global YAML only ──────────────────────────────────────────────────────────────

export interface SteeringSettings {
  enabled: boolean;
  intervalMs: number;
  notes: string[];
}

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * `steering:` block of the GLOBAL `engineering.yaml` only (a repository file cannot turn on a remote control channel).
 *   steering: { enabled: true, poll_seconds: 5 }
 * Anything malformed is OFF with a note (a remote control channel never turns on by accident).
 */
export async function loadSteeringSettings(agentDir: string): Promise<SteeringSettings> {
  const off = (note: string): SteeringSettings => ({ enabled: false, intervalMs: DEFAULT_INTERVAL_MS, notes: [note] });
  let raw: unknown;
  try {
    raw = (await readYaml(join(agentDir, "engineering.yaml"))).raw;
  } catch (err) {
    return off(`steering off: engineering.yaml unreadable (${(err as Error).message})`);
  }
  const block = isPlain(raw) ? raw.steering : undefined;
  if (block === undefined) return { enabled: false, intervalMs: DEFAULT_INTERVAL_MS, notes: [] };
  if (!isPlain(block)) return off("steering off: `steering` must be a mapping");
  const unknown = Object.keys(block).filter((k) => k !== "enabled" && k !== "poll_seconds");
  if (unknown.length) return off(`steering off: unknown keys ${unknown.join(", ")}`);
  if (typeof block.enabled !== "boolean") return off("steering off: `steering.enabled` must be true or false");
  let intervalMs = DEFAULT_INTERVAL_MS;
  if (block.poll_seconds !== undefined) {
    if (typeof block.poll_seconds !== "number" || !Number.isFinite(block.poll_seconds)) {
      return off("steering off: `steering.poll_seconds` must be a number");
    }
    intervalMs = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, block.poll_seconds * 1000));
  }
  return { enabled: block.enabled, intervalMs, notes: [] };
}

/** The control plane Pi already reports to (same variables as the convergence emitter), or null. */
export function steeringEndpointFromEnv(env: NodeJS.ProcessEnv): { baseUrl: string; apiKey?: string } | null {
  const raw = env.HERDR_INGEST_URL?.trim() ?? "";
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || u.search || u.hash)
    return null;
  const key = env.HERDR_INGEST_API_KEY?.trim() ?? "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a key with control characters could never be sent
  if (/[\u0000-\u001f\u007f]/.test(key)) return null;
  return { baseUrl: u.toString().replace(/\/+$/, ""), ...(key ? { apiKey: key } : {}) };
}

/**
 * Build the receiver, or return null when it is not enabled in the global YAML or no control plane is configured.
 * `stateDir` holds the at-most-once ledger.
 */
export async function createSteeringReceiver(input: {
  agentDir: string;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  ports: SteeringPorts;
  fetch?: typeof globalThis.fetch;
  log?: (message: string) => void;
}): Promise<SteeringReceiver | null> {
  const settings = await loadSteeringSettings(input.agentDir);
  for (const n of settings.notes) input.log?.(n);
  if (!settings.enabled) return null;
  const endpoint = steeringEndpointFromEnv(input.env);
  if (!endpoint) {
    input.log?.("steering off: no control plane is configured");
    return null;
  }
  return new SteeringReceiver({
    ...endpoint,
    ports: input.ports,
    ledger: new FileSteeringLedger(join(input.stateDir, "steering-ledger.jsonl")),
    intervalMs: settings.intervalMs,
    ...(input.fetch ? { fetch: input.fetch } : {}),
    ...(input.log ? { log: input.log } : {}),
  });
}
