/**
 * One-time load warning for leftover OpenViking configuration.
 *
 * The OpenViking HTTP transport was retired; memory is Hindsight-only. A
 * machine that still carries the old env var or a saved connection profile
 * would otherwise just see memory switched off with no explanation. This only
 * detects presence (existence checks, never reading file contents or printing
 * env values) and never throws.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveStateRoot } from "../runtime/isolation/stateDir.ts";
import { type TelemetryNotice, emitTelemetry } from "../telemetry/sink.ts";

const KEY = "memory.hindsight";
/** The retired environment variables and the YAML key that replaced each. */
const ENV_TO_YAML: Record<string, string> = {
  PI_HINDSIGHT_ENABLED: `${KEY}.enabled`,
  PI_HINDSIGHT_CLI: `${KEY}.cli`,
  PI_HINDSIGHT_SCOPES: `${KEY}.scopes`,
  PI_HINDSIGHT_TIMEOUT_MS: `${KEY}.timeout_ms`,
};

/** Names (never values) of leftover PI_HINDSIGHT_* / PI_OPENVIKING_* variables that are set. */
export function legacyMemoryEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return Object.keys(env)
      .filter((k) => /^PI_(HINDSIGHT|OPENVIKING)_/.test(k) && env[k] !== undefined)
      .sort();
  } catch {
    return [];
  }
}

function profileFiles(env: NodeJS.ProcessEnv): string[] {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return [
    join(agentDir, "engineering-memory", "connection.json"),
    join(resolveStateRoot(env), "engineering-memory", "connection.json"),
  ];
}

export function legacyOpenVikingPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (Object.keys(env).some((k) => k.startsWith("PI_OPENVIKING_") && env[k]?.trim())) return true;
    return profileFiles(env).some((p) => existsSync(p));
  } catch {
    return false;
  }
}

export function warnLegacyOpenViking(
  env: NodeJS.ProcessEnv = process.env,
  emit: (notice: TelemetryNotice) => void = emitTelemetry,
): void {
  try {
    if (!legacyOpenVikingPresent(env)) return;
    emit({
      level: "warning",
      key: "memory:legacy-openviking",
      text: "Memory: OpenViking is retired and its saved settings are ignored; memory is now Hindsight-only. Memory is on by default: install the herdr-memory CLI (herdr-eng memory install), then run /memory.",
    });
  } catch {
    /* a warning must never fail startup */
  }
}

/**
 * One-time notice for retired PI_HINDSIGHT_* / PI_OPENVIKING_* environment
 * variables. Memory is configured in YAML only and these are no longer read, so
 * a machine that still sets them would otherwise see memory silently off. The
 * notice names variables and the YAML key to use; it never reads or prints a
 * value, and never throws.
 */
export function warnLegacyMemoryEnv(
  env: NodeJS.ProcessEnv = process.env,
  emit: (notice: TelemetryNotice) => void = emitTelemetry,
): void {
  try {
    const names = legacyMemoryEnvNames(env);
    if (!names.length) return;
    const hints = names.map((n) => (ENV_TO_YAML[n] ? `${n} -> ${ENV_TO_YAML[n]}` : `${n} (no longer used)`));
    emit({
      level: "warning",
      key: "memory:legacy-env",
      text: `Memory: environment variables are no longer read; configure memory in engineering.yaml under ${KEY}. Ignoring: ${hints.join("; ")}. See docs/usage.md (Everyday memory).`,
    });
  } catch {
    /* a warning must never fail startup */
  }
}
