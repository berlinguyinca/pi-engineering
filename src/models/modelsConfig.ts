/**
 * Reading and rewriting Pi's `models.json`.
 *
 * This file holds the operator's API key. Three consequences shape everything
 * here:
 *
 *   * it is written 0600, and a rewrite must not widen that — a refresh that
 *     leaves credentials world-readable is a worse outcome than stale context
 *     windows;
 *   * only `providers.<id>.models` is ever replaced. `apiKey`, `baseUrl`,
 *     `compat` and anything a newer Pi understands are structurally untouched;
 *   * the write is atomic and takes a timestamped backup first, so a refresh
 *     that produces the wrong answer is one `cp` away from being undone, and an
 *     interrupted write cannot leave a truncated file where the credentials
 *     used to be.
 */

import { chmodSync, copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ConfiguredModel } from "./catalogPlan.ts";

/** The shape this module touches. Everything else is carried through opaquely. */
export interface ModelsConfig {
  providers?: Record<string, { models?: ConfiguredModel[]; baseUrl?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** Default profile location, matching Pi's own default. */
export function defaultModelsPath(agentDir: string = process.env.PI_AGENT_DIR ?? "~/.pi/agent"): string {
  const root = agentDir.startsWith("~") ? `${process.env.HOME ?? ""}${agentDir.slice(1)}` : agentDir;
  return join(root.replace(/\/+$/, ""), "models.json");
}

/** Read the config, or an empty one when absent. Throws only on malformed JSON. */
export function readModelsConfig(path: string): ModelsConfig {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} does not contain a JSON object`);
  }
  return parsed as ModelsConfig;
}

/** The configured model list for a provider, or an empty list. */
export function providerModels(config: ModelsConfig, providerId: string): ConfiguredModel[] {
  const models = config.providers?.[providerId]?.models;
  return Array.isArray(models) ? models : [];
}

/** The configured base URL for a provider, when set. */
export function providerBaseUrl(config: ModelsConfig, providerId: string): string | undefined {
  const url = config.providers?.[providerId]?.baseUrl;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

/**
 * Replace one provider's model list, structurally sharing everything else.
 *
 * Deliberately not a deep clone: sibling providers and every unrecognised key
 * are carried through by reference, so no field can be lost to a shape this
 * module does not model.
 */
export function withProviderModels(config: ModelsConfig, providerId: string, models: ConfiguredModel[]): ModelsConfig {
  const providers = { ...(config.providers ?? {}) };
  providers[providerId] = { ...(providers[providerId] ?? {}), models };
  return { ...config, providers };
}

export interface WriteResult {
  /** Path of the backup taken before writing, when the file already existed. */
  backupPath?: string;
}

/** A filesystem-safe timestamp for backup filenames. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

/**
 * Write the config atomically, preserving its mode and leaving a backup.
 *
 * The temporary file is created in the same directory so the rename cannot
 * cross a filesystem boundary, and at 0600 from the outset so the credentials
 * are never briefly readable at a wider mode.
 */
export function writeModelsConfig(path: string, config: ModelsConfig, now: Date = new Date()): WriteResult {
  const existed = existsSync(path);
  const mode = existed ? statSync(path).mode & 0o777 : 0o600;
  const result: WriteResult = {};

  if (existed) {
    const backupPath = `${path}.bak-${stamp(now)}`;
    copyFileSync(path, backupPath);
    chmodSync(backupPath, mode);
    result.backupPath = backupPath;
  }

  const tmp = join(dirname(path), `.models.json.tmp-${process.pid}-${Date.now()}`);
  writeFileSync(tmp, `${JSON.stringify(config, null, 1)}\n`, { mode: 0o600 });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
  return result;
}
