/**
 * Convergence emitter factory — build a ControlPlaneIngest from the process
 * environment (CI-001, FLEET-001).
 *
 * The emitter is OFF by default: unless HERDR_INGEST_URL is a valid http(s)
 * URL without credentials, query or hash, createIngestFromEnv returns null and
 * the runtime stays silent. When configured, the returned client is wired with:
 *   - host id from trimmed HERDR_HOST_ID (falls back to os.hostname())
 *   - api key from trimmed HERDR_INGEST_API_KEY (sent as an `x-api-key`
 *     header; omitted entirely when empty; the factory returns null when the
 *     key contains control characters since such a client could never send)
 *   - source "pi" (injected into every ingest payload)
 *
 * ControlPlaneIngest exposes no api-key/source fields, so those are carried by
 * wrapping its injectable fetch rather than by modifying ControlPlaneIngest.
 * The api key is never included in errors or logs.
 */

import os from "node:os";

import { ControlPlaneIngest } from "./ControlPlaneIngest.ts";
import { createIngestFromConnection, loadHerdrConnection } from "./herdrConnection.ts";

/** Wrap the default fetch to stamp the ingest request with the api key + source. */
function stampedFetch(apiKey: string | undefined): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (apiKey) headers.set("x-api-key", apiKey);

    let body = init?.body;
    if (body !== undefined && body !== null) {
      const parsed = JSON.parse(String(body)) as Record<string, unknown>;
      // v2 envelopes carry their own per-instance source; only stamp legacy bodies
      if (parsed.source === undefined) parsed.source = "pi";
      body = JSON.stringify(parsed);
    }

    return globalThis.fetch(input, { ...init, headers, body });
  }) as typeof globalThis.fetch;
}

/** True when `value` contains a control character (C0 range or DEL). */
function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Build a ControlPlaneIngest from the environment, or null when HERDR_INGEST_URL
 * is unset, blank, not a valid http(s) URL, or carries credentials, a query or a
 * hash component. An api key containing control characters also yields null
 * (such a client could never send). The key itself is never surfaced in errors
 * or logs.
 */
export function createIngestFromEnv(env: NodeJS.ProcessEnv): ControlPlaneIngest | null {
  const trimmedUrl = env.HERDR_INGEST_URL?.trim() ?? "";
  if (trimmedUrl === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmedUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.search !== "" || parsed.hash !== "") return null;

  const hostId = env.HERDR_HOST_ID?.trim() || os.hostname();

  const trimmedKey = env.HERDR_INGEST_API_KEY?.trim() ?? "";
  if (hasControlChar(trimmedKey)) return null;
  const apiKey = trimmedKey === "" ? undefined : trimmedKey;

  return new ControlPlaneIngest({
    url: parsed.toString(),
    host: { hostId },
    fetch: stampedFetch(apiKey),
  });
}

/**
 * The attention/status emitter: the legacy environment factory wins when it yields a client (no behaviour
 * change for existing installs); otherwise the global engineering.yaml `herdr:` block is used (v1 ingest, the
 * runtime caller of createIngestFromConnection). Null when neither is configured. Never rejects.
 */
export async function resolveAttentionIngest(
  env: NodeJS.ProcessEnv,
  agentDir: string,
  opts: { fetch?: typeof globalThis.fetch } = {},
): Promise<ControlPlaneIngest | null> {
  const fromEnv = createIngestFromEnv(env);
  if (fromEnv) return fromEnv;
  try {
    const { connection } = await loadHerdrConnection(agentDir);
    if (!connection) return null;
    return createIngestFromConnection(connection, connection.instanceId ?? os.hostname(), opts);
  } catch {
    return null;
  }
}
