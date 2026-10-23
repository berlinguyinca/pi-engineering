/**
 * Where Pi reaches its Herdr control plane, from the GLOBAL engineering YAML only (no environment variables):
 *
 *   herdr:
 *     url: https://herdr.example.org          # https, or http only for localhost / 127.0.0.1 / ::1
 *     api_key_file: /home/me/.config/herdr/key # absolute, mode 0600, owned by you, one line
 *     instance_id: pi-laptop-1                 # optional; names this Pi when several share one key
 *
 * A repository file cannot set it. Anything malformed or unsafe yields `null` plus a note and the caller stays
 * silent. The key is read from the file and never logged, copied into an error, or accepted inline.
 */

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readYaml } from "../../lifecycle/policy.ts";
import { ControlPlaneIngest } from "./ControlPlaneIngest.ts";

export interface HerdrConnection {
  baseUrl: string;
  apiKey?: string;
  instanceId?: string;
}

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const INSTANCE_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_KEY_FILE = 4096;

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Validate a control plane URL: https (http only on exact loopback), no userinfo, query or fragment. */
export function checkHerdrUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash) return null;
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && LOOPBACK.has(u.hostname)) return u;
  return null;
}

function readKeyFile(path: string): { key: string } | { error: string } {
  if (!isAbsolute(path)) return { error: "api_key_file must be an absolute path" };
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path);
  } catch {
    return { error: "api_key_file cannot be read" };
  }
  if (!st.isFile()) return { error: "api_key_file is not a regular file" };
  if ((st.mode & 0o077) !== 0) return { error: "api_key_file must not be readable by group or others (mode 0600)" };
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) {
    return { error: "api_key_file must be owned by the current user" };
  }
  if (st.size > MAX_KEY_FILE) return { error: "api_key_file is too large" };
  const key = readFileSync(path, "utf8").trim();
  if (!key) return { error: "api_key_file is empty" };
  for (const ch of key) {
    const c = ch.charCodeAt(0);
    if (c <= 0x1f || c === 0x7f) return { error: "api_key_file must hold a single line" };
  }
  return { key };
}

/** The `herdr:` block of the global `engineering.yaml`, or null (with a note) when absent or unsafe. */
export async function loadHerdrConnection(
  agentDir: string,
): Promise<{ connection: HerdrConnection | null; notes: string[] }> {
  let raw: unknown;
  try {
    raw = (await readYaml(join(agentDir, "engineering.yaml"))).raw;
  } catch (err) {
    return { connection: null, notes: [`herdr off: engineering.yaml unreadable (${(err as Error).message})`] };
  }
  const block = isPlain(raw) ? raw.herdr : undefined;
  if (block === undefined) return { connection: null, notes: [] };
  const off = (note: string) => ({ connection: null, notes: [`herdr off: ${note}`] });
  if (!isPlain(block)) return off("`herdr` must be a mapping");
  const unknown = Object.keys(block).filter((k) => k !== "url" && k !== "api_key_file" && k !== "instance_id");
  if (unknown.length) return off(`unknown keys ${unknown.join(", ")}`);
  if (typeof block.url !== "string") return off("`herdr.url` is required");
  const url = checkHerdrUrl(block.url);
  if (!url) return off("`herdr.url` must be https (http only for localhost, 127.0.0.1 or ::1) without credentials");
  const out: HerdrConnection = { baseUrl: url.toString().replace(/\/+$/, "") };
  if (block.api_key_file !== undefined) {
    if (typeof block.api_key_file !== "string") return off("`herdr.api_key_file` must be a path");
    const k = readKeyFile(block.api_key_file);
    if ("error" in k) return off(k.error);
    out.apiKey = k.key;
  }
  if (block.instance_id !== undefined) {
    if (typeof block.instance_id !== "string" || !INSTANCE_RE.test(block.instance_id)) {
      return off("`herdr.instance_id` must be 1-128 of A-Za-z0-9._:-");
    }
    out.instanceId = block.instance_id;
  }
  return { connection: out, notes: [] };
}

/** The ingest emitter built from the same YAML block (replaces the environment variables). */
export function createIngestFromConnection(conn: HerdrConnection, hostId: string): ControlPlaneIngest {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (conn.apiKey) headers.set("x-api-key", conn.apiKey);
    let body = init?.body;
    if (body !== undefined && body !== null) {
      const parsed = JSON.parse(String(body)) as Record<string, unknown>;
      if (parsed.source === undefined) parsed.source = "pi";
      body = JSON.stringify(parsed);
    }
    return globalThis.fetch(input, { ...init, headers, body, redirect: "error" });
  }) as typeof globalThis.fetch;
  return new ControlPlaneIngest({ url: `${conn.baseUrl}/`, host: { hostId }, fetch: fetchImpl });
}
