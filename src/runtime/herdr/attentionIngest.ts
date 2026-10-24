/**
 * The attention/status emitter, built from the global engineering.yaml `herdr:` block ONLY (operator rule: no
 * environment variables, YAML only). It is the runtime caller of `createIngestFromConnection`.
 *
 * Off unless the block is present in the GLOBAL file (a repository file cannot set it). The legacy variables
 * HERDR_INGEST_URL / HERDR_INGEST_API_KEY / HERDR_HOST_ID are no longer read. When any is set, Pi says so loudly
 * (error notice through the telemetry sink, once per process) instead of silently falling back or silently ignoring them: a key in the process
 * environment is also readable by every command Pi starts.
 */

import os from "node:os";

import { emitTelemetry } from "../../telemetry/sink.ts";
import type { ControlPlaneIngest } from "./ControlPlaneIngest.ts";
import { createIngestFromConnection, loadHerdrConnection } from "./herdrConnection.ts";

/** Names that used to configure the emitter. Exported so worker-command env scrubbing and tests share one list. */
export const LEGACY_HERDR_ENV = ["HERDR_INGEST_URL", "HERDR_INGEST_API_KEY", "HERDR_HOST_ID"] as const;

/** The legacy variables that are set (non-blank) in `env`. */
export function legacyHerdrEnvSet(env: NodeJS.ProcessEnv): string[] {
  return LEGACY_HERDR_ENV.filter((name) => (env[name] ?? "").trim() !== "");
}

/**
 * Remove the retired variables from `env`. Pi no longer reads them, and every process it starts afterwards (a
 * worker's bash, the verifier, git) would otherwise inherit a key that only ever belonged to Pi.
 */
export function scrubLegacyHerdrEnv(env: NodeJS.ProcessEnv): void {
  for (const name of LEGACY_HERDR_ENV) delete env[name];
}

let warned = false;
/** Test hook: let the once-per-process warning fire again. */
export function resetLegacyHerdrEnvWarning(): void {
  warned = false;
}

export function legacyHerdrEnvMessage(names: readonly string[], haveYaml: boolean): string {
  const head = `[pi-engineering] ERROR: ${names.join(", ")} ${names.length === 1 ? "is" : "are"} set but no longer read.`;
  const tail = haveYaml
    ? "The `herdr:` block in the global engineering.yaml is used; unset the variable(s)."
    : "Herdr reporting is OFF until you add a `herdr: {url, api_key_file, instance_id, room_id, mission_id}` block to the global engineering.yaml (see docs/usage.md) and unset the variable(s).";
  return `${head} ${tail}`;
}

/**
 * The attention emitter, or null when the global YAML has no (valid) `herdr:` block. Never rejects.
 * `env` is only inspected to report the retired variables (their values are never used) and then scrubbed of them.
 */
export async function resolveAttentionIngest(
  env: NodeJS.ProcessEnv,
  agentDir: string,
  opts: { fetch?: typeof globalThis.fetch; warn?: (line: string) => void } = {},
): Promise<ControlPlaneIngest | null> {
  let connection: Awaited<ReturnType<typeof loadHerdrConnection>>["connection"] = null;
  try {
    ({ connection } = await loadHerdrConnection(agentDir));
  } catch {
    connection = null;
  }
  const legacy = legacyHerdrEnvSet(env);
  if (legacy.length > 0 && !warned) {
    warned = true;
    const message = legacyHerdrEnvMessage(legacy, connection !== null);
    // Through the telemetry sink (the TUI owns the screen; a raw stderr write corrupts it).
    if (opts.warn) opts.warn(message);
    else emitTelemetry({ level: "error", key: "herdr-legacy-env", text: message });
  }
  scrubLegacyHerdrEnv(env);
  if (!connection) return null;
  try {
    return createIngestFromConnection(
      connection,
      connection.instanceId ?? os.hostname(),
      opts.fetch ? { fetch: opts.fetch } : {},
    );
  } catch {
    return null;
  }
}
