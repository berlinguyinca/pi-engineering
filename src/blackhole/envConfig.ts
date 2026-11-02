/**
 * Hindsight connection from the environment.
 *
 * Lets ANY pi installation that loads this package's extension connect to a
 * shared Hindsight durable-memory service without editing code — set a few
 * environment variables once and the runtime wires `blackhole` up for every
 * repository automatically.
 *
 *   PI_HINDSIGHT_BASE_URL             baseUrl (presence enables the connection)
 *   PI_HINDSIGHT_TOKEN                Bearer token, or:
 *   PI_HINDSIGHT_TOKEN_FILE           path to a file containing the token
 *   PI_HINDSIGHT_PROJECT              bank prefix (default "pi"; durable memory
 *                                     uses the `{project}-facts` bank)
 *   PI_HINDSIGHT_ENABLED              "0"/"false" forces the connection off
 *   PI_HINDSIGHT_PROVIDER_TIMEOUT_MS  bounded provider-call wait (default 10000)
 *
 * Absent `PI_HINDSIGHT_BASE_URL` ⇒ returns null and the runtime is left exactly
 * as before (backward compatible, nothing enabled by default). Fail-closed: a
 * malformed timeout falls back to the default; a missing token is allowed but
 * means the (auth-required) service will deny recall, which degrades to empty.
 */
import { readFileSync } from "node:fs";
import type { PartialBlackholeConfig } from "./config.ts";

export interface HindsightEnvConfig {
  baseUrl: string;
  token?: string;
  project: string;
  providerTimeoutMs: number;
}

export const HINDSIGHT_ENV = {
  enabled: "PI_HINDSIGHT_ENABLED",
  baseUrl: "PI_HINDSIGHT_BASE_URL",
  token: "PI_HINDSIGHT_TOKEN",
  tokenFile: "PI_HINDSIGHT_TOKEN_FILE",
  project: "PI_HINDSIGHT_PROJECT",
  timeout: "PI_HINDSIGHT_PROVIDER_TIMEOUT_MS",
} as const;

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PROJECT = "pi";

function readTokenFile(file: string | undefined): string | undefined {
  if (!file) return undefined;
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}

/** Resolve the Hindsight connection from the environment, or null if unset. */
export function resolveHindsightFromEnv(
  env: Record<string, string | undefined> = process.env,
): HindsightEnvConfig | null {
  const baseUrl = env[HINDSIGHT_ENV.baseUrl];
  if (!baseUrl || !baseUrl.trim()) return null;
  const explicit = env[HINDSIGHT_ENV.enabled];
  if (explicit === "0" || explicit === "false") return null;

  const token = env[HINDSIGHT_ENV.token]?.trim() || readTokenFile(env[HINDSIGHT_ENV.tokenFile]);
  const project = env[HINDSIGHT_ENV.project]?.trim() || DEFAULT_PROJECT;
  const rawTimeout = env[HINDSIGHT_ENV.timeout];
  const parsed = rawTimeout ? Number(rawTimeout) : Number.NaN;
  const providerTimeoutMs = Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_TIMEOUT_MS;

  return { baseUrl: baseUrl.trim(), token, project, providerTimeoutMs };
}

/**
 * Build the `blackhole` option for `EngineeringRuntime` from the environment,
 * or `undefined` when no Hindsight base URL is configured.
 */
export function hindsightBlackholeOption(
  env: Record<string, string | undefined> = process.env,
): { config: PartialBlackholeConfig } | undefined {
  const hs = resolveHindsightFromEnv(env);
  if (!hs) return undefined;
  return {
    config: {
      enabled: true,
      durable: { kind: "hindsight", baseUrl: hs.baseUrl, token: hs.token, project: hs.project },
      providerTimeoutMs: hs.providerTimeoutMs,
    },
  };
}
