/**
 * First-run memory setup for the `herdr-memory` client.
 *
 * There is no endpoint, bank or token for Pi to collect. The client keeps its own
 * project profile, credentials, offline queue and cache in `~/.config/herdr-memory`
 * (0600) and refuses to store a fact without evidence or explicit save intent. Pi
 * asks the client one question — `herdr-memory status`, the same check `/memory
 * status` uses — tells the operator once per packaged revision what that means, and
 * never collects or stores a secret, because a stored copy would be one more leak.
 */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type HindsightProbe, probeHindsightStatus, resolveHindsightFromEnv } from "./hindsight.ts";

const DIRECTORY = "engineering-memory";
const FILE = "connection.json";

export type MemorySetupOutcome = "configured" | "unconfigured" | "disabled" | "headless";

export interface MemorySetupOptions {
  profileDir?: string;
  env?: Record<string, string | undefined>;
  revision?: string;
  /** Re-run the dialog even when this revision is already confirmed. */
  force?: boolean;
  /** The one connection check; tests replace it. Defaults to `herdr-memory status`. */
  probe?: (options: { cli?: string }) => Promise<HindsightProbe>;
}

export interface MemorySetupState {
  lastConfirmedRevision: string;
  /** The revision this question was already asked for ("" when none was given). */
  lastAskedRevision: string;
  /** The client this session probed; empty when nothing usable was found. */
  client: string;
  updatedAt: string;
}

function defaultProfileDir(): string {
  const home = process.env.PI_CODING_AGENT_DIR || process.env.HOME || process.env.USERPROFILE || ".";
  return join(home, "pi-engineering");
}

function configPath(profileDir: string): string {
  return join(profileDir, DIRECTORY, FILE);
}

/** Deterministic packaged-source revision, so an update never looks like a stale prompt. */
export function memorySetupRevision(profileDir = defaultProfileDir()): string {
  const root = join(profileDir, "..");
  const hash = createHash("sha256");
  let seen = 0;
  for (const relative of ["package.json", "src/index.ts", "extensions/index.ts"]) {
    try {
      hash.update(readFileSync(join(root, relative)));
      seen++;
    } catch {
      /* An installed bundle may omit sources; the recorded version still anchors it. */
    }
  }
  if (!seen) {
    try {
      hash.update(readFileSync(join(root, "package.json")));
    } catch {
      hash.update("pi-engineering");
    }
  }
  return hash.digest("hex").slice(0, 16);
}

/**
 * The environment a session runs with. The client resolves its own project,
 * endpoint and credentials, so Pi passes through only the opt-in and the client
 * location — there is no URL, bank, or key in here.
 */
export function resolveMemoryEnvironment(
  env: Record<string, string | undefined> = process.env,
  _options: { profileDir?: string } = {},
): Record<string, string | undefined> {
  return { ...env };
}

function readState(profileDir: string): MemorySetupState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(configPath(profileDir), "utf8")) as Partial<MemorySetupState>;
    return {
      lastConfirmedRevision: typeof parsed.lastConfirmedRevision === "string" ? parsed.lastConfirmedRevision : "",
      lastAskedRevision: typeof parsed.lastAskedRevision === "string" ? parsed.lastAskedRevision : "",
      client: typeof parsed.client === "string" ? parsed.client : "",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return undefined;
  }
}

function writeState(profileDir: string, state: MemorySetupState): void {
  const directory = join(profileDir, DIRECTORY);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(directory).mode & 0o777) !== 0o700) chmodSync(directory, 0o700);
  } catch {
    /* best-effort on filesystems without POSIX modes */
  }
  const temporary = `${configPath(profileDir)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, configPath(profileDir));
  try {
    if ((statSync(configPath(profileDir)).mode & 0o777) !== 0o600) chmodSync(configPath(profileDir), 0o600);
  } catch {
    /* best-effort on filesystems without POSIX modes */
  }
}

/** What the operator must do, phrased for the failure the client actually reported. */
function guidance(status: Extract<HindsightProbe, { ok: false }>): string {
  const client = status.detail ?? "herdr-memory";
  const problem =
    status.reason === "not_installed"
      ? `${client} is not installed, so nothing can be recalled or saved`
      : status.reason === "unhealthy"
        ? "the service is reachable but unhealthy"
        : status.reason === "timeout"
          ? "the client did not answer in time"
          : status.reason === "response"
            ? "the client did not return readable status"
            : "the client rejected the request (usually a missing or revoked credential)";
  return `Durable memory is on but not usable: ${problem}.\nRun herdr-memory doctor --json to see the client profile behind this directory, fix what it reports, then run /memory status.\nNever put a key or an endpoint in a repository or in Pi settings — the client stores its own profile at 0600.`;
}

const DISCLOSURE =
  "Durable memory is on: private notes are recalled into this session as untrusted reference data, " +
  "never as instructions. /memory status and /memory search show them; /memory forget removes one.";

export async function ensureMemorySetup(
  ctx: ExtensionContext,
  options: MemorySetupOptions = {},
): Promise<MemorySetupOutcome> {
  const env = options.env ?? process.env;
  // Opt-in only: without PI_HINDSIGHT_ENABLED there is no memory and nothing to set up.
  const connection = resolveHindsightFromEnv(env);
  if (!connection) return "disabled";
  const profileDir = options.profileDir ?? defaultProfileDir();
  const revision = options.revision ?? "";
  const cli = connection.cli;
  const probe = options.probe ?? probeHindsightStatus;
  const before = readState(profileDir);
  const status = await probe({ cli });

  // Another session may have answered while this probe was running; that answer
  // wins, and a stale result must not overwrite it.
  const current = readState(profileDir);
  if (JSON.stringify(current) !== JSON.stringify(before)) {
    ctx.ui.notify("Memory connection changed during setup; run /memory setup again.", "info");
    return current?.client ? "configured" : "unconfigured";
  }

  const confirmed = Boolean(revision) && before?.lastConfirmedRevision === revision;
  const headless = !ctx.hasUI || (ctx as { mode?: string }).mode === "rpc";

  if (status.ok) {
    writeState(profileDir, {
      lastConfirmedRevision: revision,
      lastAskedRevision: revision,
      client: cli,
      updatedAt: new Date().toISOString(),
    });
    // There is nothing to re-collect: no endpoint, no bank, no token. An explicit
    // /memory setup on a working client is answered with the truth, not a question.
    if (!headless) {
      if (options.force)
        ctx.ui.notify(
          `Memory is already set up: ${cli}${status.project ? ` (project ${status.project})` : ""}. The client keeps its own profile; change it with herdr-memory, not here.`,
          "info",
        );
      else if (!confirmed) ctx.ui.notify(DISCLOSURE, "info");
    }
    return "configured";
  }

  if (headless) {
    // Workers and RPC callers must not be interrupted, and silence is never a
    // false "ready" — the reason is still stated once.
    ctx.ui.notify(`${guidance(status)}\nOn a machine with a terminal, run /memory setup there.`, "info");
    return "headless";
  }

  // One question per packaged revision per client: a dialog that reappears every
  // session teaches the operator to dismiss it without reading.
  if ((confirmed || before?.lastAskedRevision === revision) && !options.force) return "unconfigured";

  const choices = ["Set up now", "Later"] as const;
  const answer = await ctx.ui.select("Hindsight durable memory is not usable yet", [...choices]);
  if (answer === "Later") return "unconfigured"; // asked again next session; nothing written
  writeState(profileDir, {
    lastConfirmedRevision: "",
    lastAskedRevision: revision,
    client: "",
    updatedAt: new Date().toISOString(),
  });
  ctx.ui.notify(guidance(status), "info");
  return "unconfigured";
}
