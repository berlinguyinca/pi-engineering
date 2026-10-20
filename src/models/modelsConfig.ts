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

import { randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  /** Older backups removed to keep the credential-bearing set bounded. */
  prunedBackups?: string[];
}

/**
 * Backups to keep. Each one contains the API key, so an unbounded set is a
 * slowly growing pile of credential copies; a handful is enough to recover from
 * a bad refresh, which is all they are for.
 */
export const MAX_BACKUPS = 5;

/** A filesystem-safe timestamp for backup filenames. */
function stamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace("T", "-").replace(".", "-");
}

function createBackup(path: string, mode: number, now: Date): string {
  const prefix = `${path}.bak-${stamp(now)}`;
  for (;;) {
    const candidate = `${prefix}-${randomUUID()}`;
    try {
      copyFileSync(path, candidate, constants.COPYFILE_EXCL);
      chmodSync(candidate, mode);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/**
 * Write the config atomically, preserving its mode and leaving a backup.
 *
 * The temporary file is created in the same directory so the rename cannot
 * cross a filesystem boundary, and at 0600 from the outset so the credentials
 * are never briefly readable at a wider mode.
 */
export function writeModelsConfig(
  path: string,
  config: ModelsConfig,
  now: Date = new Date(),
  writer = "unlabelled",
): WriteResult {
  const existed = existsSync(path);
  const mode = existed ? statSync(path).mode & 0o777 : 0o600;
  const result: WriteResult = {};

  if (existed) {
    const backupPath = createBackup(path, mode, now);
    result.backupPath = backupPath;
  }

  const tmp = join(dirname(path), `.models.json.tmp-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(config, null, 1)}\n`, { mode: 0o600 });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    // The temporary file holds the API key. Leaving one behind after a failed
    // write is a stray credential copy nobody will think to look for.
    rmSync(tmp, { force: true });
    if (result.backupPath) rmSync(result.backupPath, { force: true });
    throw err;
  }

  recordWriter(path, config, now, writer);
  const pruned = pruneBackups(path, result.backupPath);
  if (pruned.length > 0) result.prunedBackups = pruned;
  return result;
}

const MAX_WRITER_LINES = 200;
const MAX_WRITER_HISTORY_BYTES = 256 * 1024;

/** Paths, credentials and query parameters may all contain API keys. */
function writerProviderOrigins(config: ModelsConfig): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(config.providers ?? {}).map(([id, provider]) => {
      if (typeof provider?.baseUrl !== "string") return [id, null];
      try {
        const url = new URL(provider.baseUrl);
        if (url.protocol === "https:" || url.protocol === "http:") return [id, url.origin];
      } catch {
        // An unparseable endpoint must not be echoed into the audit log.
      }
      return [id, "(configured endpoint)"];
    }),
  );
}

function writerHistory(log: string): string[] {
  let fd: number;
  try {
    fd = openSync(log, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error("Not a private regular audit log");
    const start = Math.max(0, info.size - MAX_WRITER_HISTORY_BYTES);
    const buffer = Buffer.alloc(Math.min(info.size, MAX_WRITER_HISTORY_BYTES));
    const bytes = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.subarray(0, bytes).toString("utf8").split("\n");
    if (start > 0) lines.shift(); // The bounded tail may begin inside a record.
    return lines
      .filter(Boolean)
      .slice(-(MAX_WRITER_LINES - 1))
      .flatMap((line) => {
        try {
          const entry = JSON.parse(line);
          // Scrub URLs written by earlier versions, too. Invalid records are not
          // copied forward: they may be truncated or contain unstructured secrets.
          const providers = Object.fromEntries(
            Object.entries(entry.providers).map(([id, baseUrl]) => [
              id,
              { baseUrl: typeof baseUrl === "string" ? baseUrl : undefined },
            ]),
          );
          return [JSON.stringify({ ...entry, providers: writerProviderOrigins({ providers }) })];
        } catch {
          return [];
        }
      });
  } finally {
    closeSync(fd);
  }
}

/**
 * Append who wrote the file to `<path>.writers.log`, so an unexplained change
 * (a provider that vanished, a URL that moved) can be traced to a process.
 * Holds provider ids and HTTP(S) origins only, never URL credentials or paths.
 * Best effort: a log we cannot write must not fail a write that succeeded.
 */
function recordWriter(path: string, config: ModelsConfig, now: Date, writer: string): void {
  let tmp: string | undefined;
  try {
    const providers = writerProviderOrigins(config);
    const entry = JSON.stringify({
      at: now.toISOString(),
      writer,
      pid: process.pid,
      ppid: process.ppid,
      argv: process.argv.slice(0, 2).map((a) => a.split("/").pop()),
      providers,
    });
    const log = `${path}.writers.log`;
    const lines = [...writerHistory(log), entry];
    const candidate = join(dirname(path), `.models.writers.tmp-${randomUUID()}`);
    const fd = openSync(candidate, "wx", 0o600);
    tmp = candidate;
    try {
      writeFileSync(fd, `${lines.join("\n")}\n`);
    } finally {
      closeSync(fd);
    }
    // Replacing the inode enforces 0600 even for an old, permissive log and
    // cannot write through a symlink/hardlink swapped in during the read.
    renameSync(tmp, log);
  } catch {
    // see above
  } finally {
    if (tmp) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // Audit cleanup must not fail the successful models.json write either.
      }
    }
  }
}

/** Remove all but the newest `MAX_BACKUPS` backups of `path`. */
function pruneBackups(path: string, protectedPath?: string): string[] {
  const dir = dirname(path);
  const prefix = `${path.slice(dir.length + 1)}.bak-`;
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(prefix));
  } catch {
    return [];
  }
  // Names embed a sortable timestamp. Never select the backup just returned:
  // clocks can move backwards and same-millisecond writes sort by UUID.
  const protectedName = protectedPath?.slice(dir.length + 1);
  const candidates = names.filter((name) => name !== protectedName).sort();
  const stale = candidates.slice(0, Math.max(0, names.length - MAX_BACKUPS));
  const removed: string[] = [];
  for (const name of stale) {
    const full = join(dir, name);
    try {
      rmSync(full, { force: true });
      removed.push(full);
    } catch {
      // A backup we cannot remove is not worth failing a successful write over.
    }
  }
  return removed;
}
