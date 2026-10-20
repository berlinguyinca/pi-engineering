/**
 * Where `/model-sync` gets the canonical provider definition from.
 *
 * Configured in `<agent dir>/model-sync.json`:
 *
 *     { "source": "ssh://bender/home/me/.pi/agent/canonical-providers.json" }
 *
 * `source` is a file path, an `http(s)://` URL, or `ssh://host/absolute/path`.
 * The definition is pulled, never pushed: each machine fetches what it needs and
 * keeps its own key, so adding a machine means writing one small file on it.
 */

import { execFile } from "node:child_process";
import { constants, closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { defaultModelsPath } from "./modelsConfig.ts";

const execFileAsync = promisify(execFile);

const MAX_BYTES = 1_000_000;
const FETCH_TIMEOUT_MS = 20_000;

export function defaultSyncConfigPath(): string {
  return join(dirname(defaultModelsPath()), "model-sync.json");
}

export type SyncSource =
  | { kind: "file"; path: string }
  | { kind: "http"; url: string }
  | { kind: "ssh"; host: string; path: string };

export function parseSyncSource(source: string): SyncSource {
  const value = source.trim();
  if (/^https?:\/\//.test(value)) return { kind: "http", url: value };
  if (value.startsWith("ssh://")) {
    const rest = value.slice("ssh://".length);
    const slash = rest.indexOf("/");
    const host = slash < 0 ? rest : rest.slice(0, slash);
    const path = slash < 0 ? "" : rest.slice(slash);
    // A host starting with "-" would be read by ssh as an option.
    // The remote shell re-parses the path, so only plain path characters are accepted.
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(host) || !/^\/[A-Za-z0-9_.\/+@:-]+$/.test(path)) {
      throw new Error(`model-sync source ${value} must look like ssh://host/absolute/path`);
    }
    return { kind: "ssh", host, path };
  }
  if (value.length === 0) throw new Error("model-sync source is empty");
  return { kind: "file", path: value.startsWith("~/") ? join(process.env.HOME ?? "", value.slice(2)) : value };
}

/** Read the configured source. Throws a message fit to show an operator. */
export function readSyncSourceSetting(configPath: string = defaultSyncConfigPath()): string {
  let text: string;
  try {
    text = readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `no sync source configured. Create ${configPath} with {"source": "ssh://host/path/canonical-providers.json"}`,
      );
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${configPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const source = (parsed as { source?: unknown } | null)?.source;
  if (typeof source !== "string") throw new Error(`${configPath} needs a "source" string`);
  return source;
}

/** Whether `model-sync.json` asks for a quiet drift check at session start. Never throws. */
export function readCheckOnStart(configPath: string = defaultSyncConfigPath()): boolean {
  try {
    return (JSON.parse(readFileSync(configPath, "utf8")) as { checkOnStart?: unknown }).checkOnStart === true;
  } catch {
    return false;
  }
}

/** Fetch the canonical definition's text from `source`. */
export async function fetchCanonicalText(source: SyncSource, signal?: AbortSignal): Promise<string> {
  let text: string;
  if (source.kind === "file") {
    const fd = openSync(source.path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("canonical providers source must be a regular file");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
        if (count === 0) break;
        bytes += count;
      }
      if (bytes > MAX_BYTES) throw new Error("canonical providers are larger than 1 MB");
      text = buffer.subarray(0, bytes).toString("utf8");
    } finally {
      closeSync(fd);
    }
  } else if (source.kind === "http") {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const res = await fetch(source.url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) throw new Error(`${source.url} answered HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error("canonical providers response has no body");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_BYTES) {
          await reader.cancel();
          throw new Error("canonical providers are larger than 1 MB");
        }
        chunks.push(chunk.value);
      }
      text = Buffer.concat(chunks, bytes).toString("utf8");
    } finally {
      reader.releaseLock();
    }
  } else {
    // No shell: host and path are separate argv entries, and `--` ends ssh's options.
    const { stdout } = await execFileAsync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", source.host, "cat", "--", source.path],
      { maxBuffer: MAX_BYTES, timeout: FETCH_TIMEOUT_MS, ...(signal ? { signal } : {}) },
    );
    text = stdout;
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BYTES) throw new Error("canonical providers are larger than 1 MB");
  return text;
}
