/**
 * Opt-in wiring of the lineage emitter from the central fleet config (the same
 * `host.json` + `/api/v1/fleet/config` path the inspector feed uses). No
 * environment variable is read.
 *
 * Both keys must be boolean `true`, otherwise nothing is built and Pi behaves
 * exactly as before:
 *   lineage.enabled  - emit typed lineage events
 *   ingest.outbox    - stage them in the durable envelope-v2 outbox (the only
 *                      delivery path lineage uses; a v1 ingest cannot carry it)
 * The control-plane URL and key come from the host config itself.
 */

import { ControlPlaneIngest } from "./ControlPlaneIngest.ts";
import { type HostConfig, type LoadHostConfigOptions, loadHostConfig } from "./HostConfig.ts";
import { EnvelopeStore } from "./envelopeStore.ts";
import { type LineageEmitter, createLineageEmitter } from "./lineage.ts";

export interface LineageWiringOptions {
  fetch?: typeof globalThis.fetch;
  /** Outbox / sequence directory; default `<state root>/control-plane`. */
  envelopeDir?: string;
}

export function lineageEnabledByConfig(cfg: Pick<HostConfig, "get">): boolean {
  return cfg.get<unknown>("lineage.enabled", false) === true && cfg.get<unknown>("ingest.outbox", false) === true;
}

/** Build the emitter when the config enables it, else null. Builds one EnvelopeStore + ingest. */
export function createLineageFromHostConfig(
  cfg: Pick<HostConfig, "url" | "hostId" | "apiKey" | "get">,
  opts: LineageWiringOptions = {},
): LineageEmitter | null {
  if (!lineageEnabledByConfig(cfg)) return null;
  const store = new EnvelopeStore(opts.envelopeDir ? { dir: opts.envelopeDir } : {});
  const ingest = new ControlPlaneIngest({
    url: cfg.url,
    host: { hostId: cfg.hostId },
    ...(cfg.apiKey ? { apiKey: cfg.apiKey } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    envelopeStore: store,
  });
  return createLineageEmitter({ ingest });
}

/**
 * Load the host config and build the emitter. NEVER rejects: a missing host.json,
 * unreachable control plane or disabled flag all resolve null.
 */
export async function loadLineageEmitter(
  opts: LineageWiringOptions & { hostConfig?: LoadHostConfigOptions; log?: (line: string) => void } = {},
): Promise<LineageEmitter | null> {
  try {
    const host = await loadHostConfig({
      timeoutMs: 1500,
      ...opts.hostConfig,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
    const emitter = createLineageFromHostConfig(host, opts);
    if (emitter) opts.log?.("[lineage] on");
    return emitter;
  } catch {
    return null;
  }
}
