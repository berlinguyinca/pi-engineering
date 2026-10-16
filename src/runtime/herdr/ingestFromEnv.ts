/**
 * Convergence emitter factory — build a ControlPlaneIngest from the process
 * environment (CI-001, FLEET-001).
 *
 * The emitter is OFF by default: unless HERDR_INGEST_URL is a valid http(s)
 * URL, createIngestFromEnv returns null and the runtime stays silent. When
 * configured, the returned client is wired with:
 *   - host id from HERDR_HOST_ID ?? os.hostname()
 *   - api key from HERDR_INGEST_API_KEY (sent as an `x-api-key` header)
 *   - source "pi" (injected into every ingest payload)
 *
 * ControlPlaneIngest exposes no api-key/source fields, so those are carried by
 * wrapping its injectable fetch rather than by modifying ControlPlaneIngest.
 */

import os from "node:os";

import { ControlPlaneIngest } from "./ControlPlaneIngest.ts";

/** Wrap the default fetch to stamp the ingest request with the api key + source. */
function stampedFetch(apiKey: string | undefined): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (apiKey) headers.set("x-api-key", apiKey);

    let body = init?.body;
    if (body !== undefined && body !== null) {
      const parsed = JSON.parse(String(body)) as Record<string, unknown>;
      parsed.source = "pi";
      body = JSON.stringify(parsed);
    }

    return globalThis.fetch(input, { ...init, headers, body });
  }) as typeof globalThis.fetch;
}

/**
 * Build a ControlPlaneIngest from the environment, or null when HERDR_INGEST_URL
 * is unset or not a valid http(s) URL.
 */
export function createIngestFromEnv(env: NodeJS.ProcessEnv): ControlPlaneIngest | null {
  const rawUrl = env.HERDR_INGEST_URL;
  if (!rawUrl) return null;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  const hostId = env.HERDR_HOST_ID ?? os.hostname();
  const apiKey = env.HERDR_INGEST_API_KEY;

  return new ControlPlaneIngest({
    url: parsed.toString(),
    host: { hostId },
    fetch: stampedFetch(apiKey),
  });
}
