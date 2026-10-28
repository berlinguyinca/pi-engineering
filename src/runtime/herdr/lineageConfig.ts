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

import { hostname } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ControlPlaneIngest } from "./ControlPlaneIngest.ts";
import { type HostConfig, type LoadHostConfigOptions, loadHostConfig } from "./HostConfig.ts";
import { EnvelopeStore } from "./envelopeStore.ts";
import { type HerdrConnection, loadHerdrConnection } from "./herdrConnection.ts";
import { type LineageEmitter, createLineageEmitter } from "./lineage.ts";

export interface LineageWiringOptions {
  fetch?: typeof globalThis.fetch;
  /** Outbox / sequence directory; default `<state root>/control-plane`. */
  envelopeDir?: string;
}

export interface ConnectionLineageOptions extends LineageWiringOptions {
  log?: (line: string) => void;
}

/**
 * Lineage from the global engineering.yaml `herdr:` block (no environment variables). Null unless
 * `conn.lineage === true`. The ingest gets a durable envelope store: a store-less ingest (what
 * createIngestFromConnection builds by default) is v1-only, has no diagnostics() and so
 * createLineageEmitter would return null for it. The key is sent directly (never logged) and
 * redirects are refused. room/workspace/mission ids become the emitter's default scope and
 * `visibility` (default private) is the scope of every event.
 */
export function createLineageFromConnection(
  conn: HerdrConnection,
  hostId: string,
  opts: LineageWiringOptions = {},
): LineageEmitter | null {
  if (conn.lineage !== true) return null;
  const base = opts.fetch ?? globalThis.fetch;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    base(input, { ...init, redirect: "error" })) as typeof globalThis.fetch;
  const store = new EnvelopeStore(opts.envelopeDir ? { dir: opts.envelopeDir } : {});
  const ingest = new ControlPlaneIngest({
    url: `${conn.baseUrl}/`,
    host: { hostId },
    ...(conn.apiKey ? { apiKey: conn.apiKey } : {}),
    fetch: fetchImpl,
    envelopeStore: store,
  });
  const defaultScope = {
    ...(conn.roomId ? { room_id: conn.roomId } : {}),
    ...(conn.workspaceId ? { workspace_id: conn.workspaceId } : {}),
    ...(conn.missionId ? { mission_id: conn.missionId } : {}),
  };
  return createLineageEmitter(
    { ingest },
    {
      visibility: conn.visibility ?? "private",
      ...(Object.keys(defaultScope).length ? { defaultScope } : {}),
      ...(conn.instanceId ? { instanceId: conn.instanceId } : {}),
    },
  );
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
  opts: LineageWiringOptions & {
    hostConfig?: LoadHostConfigOptions;
    log?: (line: string) => void;
    /** Directory holding the global engineering.yaml; default Pi's agent dir. */
    agentDir?: string;
    /**
     * Only the global engineering.yaml `herdr:` block may turn lineage on; the fleet host-config path (which fetches
     * from a control plane named by `host.json`) is not tried. The short-lived CLIs use this: no `herdr:` block
     * means no emitter and no network, whatever else is installed on the machine.
     */
    yamlOnly?: boolean;
  } = {},
): Promise<LineageEmitter | null> {
  // The global YAML `herdr:` block wins when it turns lineage on; otherwise the host-config path below.
  try {
    const { connection, notes } = await loadHerdrConnection(opts.agentDir ?? getAgentDir());
    for (const n of notes) opts.log?.(n);
    if (connection?.lineage === true) {
      const emitter = createLineageFromConnection(connection, connection.instanceId ?? hostname(), opts);
      if (emitter) {
        opts.log?.("[lineage] on (engineering.yaml)");
        return emitter;
      }
    }
  } catch {
    // fall through to the host-config path
  }
  if (opts.yamlOnly) return null;
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
