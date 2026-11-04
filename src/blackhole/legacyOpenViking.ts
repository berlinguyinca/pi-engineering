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

const LEGACY_ENV = "PI_OPENVIKING_BASE_URL";

function profileFiles(env: NodeJS.ProcessEnv): string[] {
  const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return [
    join(agentDir, "engineering-memory", "connection.json"),
    join(resolveStateRoot(env), "engineering-memory", "connection.json"),
  ];
}

export function legacyOpenVikingPresent(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    if (env[LEGACY_ENV]?.trim()) return true;
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
      text: "Memory: OpenViking is retired and its saved settings are ignored; memory is now Hindsight-only. Install the herdr-memory CLI and set PI_HINDSIGHT_ENABLED=1, then run /memory.",
    });
  } catch {
    /* a warning must never fail startup */
  }
}
