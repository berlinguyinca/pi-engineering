/**
 * HostConfig — central fleet configuration client (parity with
 * herdr-engineering `host_config.py` and the feed plugin's `host-config.js`).
 *
 * Reads ~/.config/herdr-engineering/host.json {control_plane_url, host_id, token}
 * (written by `herdr-eng fleet join`), fetches GET {url}/api/v1/fleet/config and
 * caches it in ~/.cache/herdr-engineering/fleet-config.json (0600, dir 0700).
 * A revoked token (HTTP 401) deletes the cache. Redirects are never followed and
 * neither the token nor any value appears in an error message.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOST_JSON_REL = [".config", "herdr-engineering", "host.json"];
const CACHE_REL = [".cache", "herdr-engineering", "fleet-config.json"];
const FLEET_PATH = "/api/v1/fleet/config";
const APPLIED_PATH = "/api/v1/fleet/config/applied";
const JOIN_HINT = "run `herdr-eng fleet join` for this host on the control-plane host";

export class HostConfigUnavailable extends Error {
  /** True only for HTTP 401 (machine-readable; carries no secret). */
  readonly revoked: boolean;
  constructor(reason: string, opts: { revoked?: boolean } = {}) {
    super(`host config unavailable: ${reason}`);
    this.name = "HostConfigUnavailable";
    this.revoked = opts.revoked ?? false;
  }
}

export type FleetValues = Record<string, Record<string, unknown>>;

export interface HostConfig {
  url: string;
  hostId: string;
  revision: string;
  source: "fetch" | "cache";
  values: FleetValues;
  /** agent.api_key, falling back to ingest.api_key. */
  apiKey: string | null;
  get<T = unknown>(dottedKey: string, fallback?: T): T;
}

export interface LoadHostConfigOptions {
  home?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function readHostJson(home: string): { url: string; hostId: string; token: string } {
  const path = join(home, ...HOST_JSON_REL);
  let data: any;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new HostConfigUnavailable(`host.json missing or unreadable at ${path}; ${JOIN_HINT}`);
  }
  const { control_plane_url: url, host_id: hostId, token } = data ?? {};
  if (![url, hostId, token].every((x) => typeof x === "string" && x)) {
    throw new HostConfigUnavailable(`host.json at ${path} is incomplete; ${JOIN_HINT}`);
  }
  return { url: (url as string).replace(/\/+$/, ""), hostId, token };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function writeCache(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.fleet-config.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600, flag: "wx" });
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* already gone */
    }
    throw err;
  }
}

function readCache(path: string, hostId: string): { revision: string; values: FleetValues } | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data.host_id !== hostId) return null;
    if (typeof data.revision !== "string" || !isPlainObject(data.values)) return null;
    return { revision: data.revision, values: data.values as FleetValues };
  } catch {
    return null;
  }
}

function build(
  url: string,
  hostId: string,
  revision: string,
  values: FleetValues,
  source: "fetch" | "cache",
): HostConfig {
  const get = (dottedKey: string, fallback?: unknown): any => {
    const i = dottedKey.indexOf(".");
    if (i < 0) return fallback;
    const node = values?.[dottedKey.slice(0, i)];
    const key = dottedKey.slice(i + 1);
    if (!isPlainObject(node) || !(key in node) || node[key] == null) return fallback;
    return node[key];
  };
  const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
  return {
    url,
    hostId,
    revision,
    source,
    values,
    apiKey: str(get("agent.api_key")) ?? str(get("ingest.api_key")),
    get,
  };
}

export async function loadHostConfig(opts: LoadHostConfigOptions = {}): Promise<HostConfig> {
  const home = opts.home ?? homedir();
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const { url, hostId, token } = readHostJson(home);
  const cachePath = join(home, ...CACHE_REL);
  const request = (path: string, init: RequestInit = {}) =>
    doFetch(url + path, {
      ...init,
      headers: { "X-Host-Token": token, Accept: "application/json", ...((init.headers as object) ?? {}) },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });

  let status: number | null = null;
  let payload: any = null;
  try {
    const res = await request(FLEET_PATH);
    status = res.status;
    if (status === 200) {
      try {
        payload = JSON.parse(await res.text());
      } catch {
        payload = null;
      }
    }
  } catch {
    status = null; // network failure or timeout: fall back to the cache
  }

  if (status === 401) {
    try {
      unlinkSync(cachePath);
    } catch {
      /* none */
    }
    throw new HostConfigUnavailable(
      `the control plane rejected this host's token (revoked or unknown); cached configuration was discarded; ${JOIN_HINT}`,
      { revoked: true },
    );
  }
  if (status === 200 && payload && typeof payload.revision === "string" && isPlainObject(payload.values)) {
    const { revision, values } = payload as { revision: string; values: FleetValues };
    try {
      writeCache(cachePath, { host_id: hostId, revision, values });
    } catch {
      /* cache is optional */
    }
    try {
      await request(APPLIED_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_id: hostId, revision }),
      });
    } catch {
      /* best effort */
    }
    return build(url, hostId, revision, values, "fetch");
  }
  if (status !== null && status >= 400 && status < 500) {
    throw new HostConfigUnavailable(`the control plane refused the configuration request (HTTP ${status})`);
  }
  const cached = readCache(cachePath, hostId); // unreachable, 3xx, 5xx or malformed
  if (!cached) throw new HostConfigUnavailable(`control plane at ${url} unreachable and no cached configuration exists`);
  return build(url, hostId, cached.revision, cached.values, "cache");
}
