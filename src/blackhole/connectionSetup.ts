/** Profile-owned Viking connection; independent of repositories and shell startup files. */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth } from "@earendil-works/pi-tui";
import { OpenVikingProvider, OpenVikingRequestError } from "./durable.ts";
import { resolveOpenVikingFromEnv } from "./envConfig.ts";

interface ConnectionProfile {
  baseUrl: string;
  tokenFile: string;
  lastConfirmedRevision: string;
}

export interface MemorySetupOptions {
  /** Agent profile root, not the directory of the current repository. */
  profileDir?: string;
  env?: NodeJS.ProcessEnv;
  revision?: string;
  force?: boolean;
  fetch?: typeof globalThis.fetch;
}

function profilePath(env: NodeJS.ProcessEnv, options: MemorySetupOptions): string {
  return join(
    options.profileDir ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    "engineering-memory",
    "connection.json",
  );
}

function readProfile(path: string): ConnectionProfile | undefined {
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      data &&
      typeof data === "object" &&
      "baseUrl" in data &&
      typeof data.baseUrl === "string" &&
      "tokenFile" in data &&
      typeof data.tokenFile === "string" &&
      isAbsolute(data.tokenFile) &&
      "lastConfirmedRevision" in data &&
      typeof data.lastConfirmedRevision === "string"
    ) {
      return data as ConnectionProfile;
    }
  } catch {
    // Missing/invalid settings should fall back to the existing environment.
  }
  return undefined;
}

/** Explicitly saved connection choices win over stale shell defaults. Disable always wins. */
export function resolveMemoryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  options: MemorySetupOptions = {},
): NodeJS.ProcessEnv {
  const result = { ...env };
  const profile = readProfile(profilePath(env, options));
  if (profile) {
    result.PI_OPENVIKING_BASE_URL = profile.baseUrl;
    result.PI_OPENVIKING_TOKEN_FILE = profile.tokenFile;
    delete result.PI_OPENVIKING_TOKEN;
  }
  return result;
}

/** Detect changes while dialogs or credential verification yielded to another session. */
function connectionFingerprint(env: NodeJS.ProcessEnv, options: MemorySetupOptions): string {
  const path = profilePath(env, options);
  const hash = createHash("sha256").update(path);
  try {
    hash.update(readFileSync(path));
  } catch (error) {
    hash.update(String((error as NodeJS.ErrnoException).code));
  }
  const effective = resolveMemoryEnvironment(env, options);
  hash.update(
    JSON.stringify({
      enabled: effective.PI_OPENVIKING_ENABLED,
      baseUrl: effective.PI_OPENVIKING_BASE_URL,
      tokenFile: effective.PI_OPENVIKING_TOKEN_FILE,
      token: effective.PI_OPENVIKING_TOKEN,
      connection: resolveOpenVikingFromEnv(effective),
    }),
  );
  return hash.digest("hex");
}

/** Stable across chats, sensitive to both git updates and packaged source changes. */
export function memorySetupRevision(packageRoot = fileURLToPath(new URL("../../", import.meta.url))): string {
  const hash = createHash("sha256");
  if (existsSync(join(packageRoot, ".git"))) {
    try {
      hash.update(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: packageRoot,
          timeout: 1000,
          maxBuffer: 1024,
          stdio: ["ignore", "pipe", "ignore"],
        }),
      );
    } catch {
      // Packaged content below remains sufficient when git is unavailable.
    }
  }
  function add(path: string): void {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) add(full);
      else if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name)) {
        hash.update(full.slice(packageRoot.length));
        hash.update(readFileSync(full));
      }
    }
  }
  hash.update(readFileSync(join(packageRoot, "package.json")));
  for (const directory of ["src", "extensions"]) {
    if (existsSync(join(packageRoot, directory))) add(join(packageRoot, directory));
  }
  return hash.digest("hex");
}

async function promptKey(ctx: ExtensionContext): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
    let input: Input | undefined = new Input();
    input.onSubmit = (value) => done(value.trim() || undefined);
    input.onEscape = () => done(undefined);
    return {
      handleInput(data: string) {
        input?.handleInput(data);
        tui.requestRender();
      },
      render(width: number) {
        // Never render Input itself: the native widget has no password mode.
        return [
          "Viking access key (hidden)",
          `> ${"*".repeat(Math.min(input?.getValue().length ?? 0, Math.max(0, width - 2)))}`,
          "Enter to save · Esc to cancel",
        ].map((line) => truncateToWidth(line, Math.max(1, width)));
      },
      invalidate() {},
      dispose() {
        input = undefined;
      },
    };
  });
}

function atomicWrite(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Renamed or never created. */
    }
  }
}

/** Ask once after each extension update, or explicitly through /memory setup. */
export async function ensureMemorySetup(ctx: ExtensionContext, options: MemorySetupOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  if (!ctx.hasUI || ctx.mode !== "tui") {
    if (options.force)
      ctx.ui.notify("Run /memory setup in an interactive terminal to enter your Viking host and key securely.", "info");
    return;
  }
  if (env.PI_OPENVIKING_ENABLED === "0" || env.PI_OPENVIKING_ENABLED === "false") {
    if (options.force)
      ctx.ui.notify(
        "OpenViking is disabled by PI_OPENVIKING_ENABLED. Remove that override before running /memory setup.",
        "info",
      );
    return;
  }
  let newTokenFile: string | undefined;
  try {
    const path = profilePath(env, options);
    const initialFingerprint = connectionFingerprint(env, options);
    const profile = readProfile(path);
    const effective = resolveMemoryEnvironment(env, options);
    const current = resolveOpenVikingFromEnv(effective);
    const revision = options.revision ?? memorySetupRevision();
    // A connection that works needs no confirmation. This used to re-ask on
    // every revision bump — i.e. after every install or update — which trains
    // the operator to dismiss a dialog rather than read it, and asks a question
    // whose answer is already on disk and demonstrably working.
    //
    // The prompt is now for the case it was written for: nothing configured.
    // Changing a working connection is `/memory setup`, which passes `force`.
    if (!options.force && current?.baseUrl && current.token) {
      // Still record that this revision has been seen, so the profile does not
      // look stale to anything else reading it.
      if (profile && profile.lastConfirmedRevision !== revision) {
        try {
          atomicWrite(path, `${JSON.stringify({ ...profile, lastConfirmedRevision: revision }, null, 2)}\n`);
        } catch {
          /* A bookkeeping write is never worth failing startup for. */
        }
      }
      return;
    }
    const configured = Boolean(current?.baseUrl && current.token);
    let hostLabel = "not configured";
    try {
      if (current?.baseUrl) hostLabel = new URL(current.baseUrl).origin;
    } catch {
      /* Invalid host is corrected in setup. */
    }
    const action = await ctx.ui.select(
      `OpenViking memory — confirm connection after install/update (${hostLabel})`,
      configured ? ["Keep current connection", "Change connection", "Later"] : ["Set up connection", "Later"],
    );
    if (!action || action === "Later") return;
    let baseUrl = current?.baseUrl ?? "https://viking.metabolomics.us";
    let token = current?.token;
    let tokenFile = effective.PI_OPENVIKING_TOKEN?.trim() ? undefined : effective.PI_OPENVIKING_TOKEN_FILE;
    if (action !== "Keep current connection") {
      const host = await ctx.ui.input("Viking host URL (HTTPS)", baseUrl);
      if (host === undefined) return;
      baseUrl = host.trim() || baseUrl;
      // Validate the destination before asking for a credential.
      new OpenVikingProvider({ baseUrl, strict: true });
      token = await promptKey(ctx);
      if (!token) return;
      tokenFile = undefined;
    }
    if (!token) return;
    await new OpenVikingProvider({ baseUrl, token, strict: true, timeoutMs: 5000, fetch: options.fetch }).recallAll();
    if (connectionFingerprint(env, options) !== initialFingerprint) {
      ctx.ui.notify(
        "OpenViking settings or credentials changed during setup. Run /memory setup to retry with the current connection.",
        "warning",
      );
      return;
    }
    // Keep the check and writes synchronous: another session cannot interleave here.
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(path), 0o700);
    if (!tokenFile) {
      // Unique secret avoids replacing a working credential before settings commit.
      newTokenFile = join(dirname(path), `viking-${randomUUID()}.key`);
      atomicWrite(newTokenFile, `${token}\n`);
      tokenFile = newTokenFile;
    }
    const saved: ConnectionProfile = { baseUrl, tokenFile: resolve(tokenFile), lastConfirmedRevision: revision };
    atomicWrite(path, `${JSON.stringify(saved, null, 2)}\n`);
    newTokenFile = undefined;
    if (
      profile &&
      profile.tokenFile !== saved.tokenFile &&
      dirname(profile.tokenFile) === resolve(dirname(path)) &&
      /^viking-[a-f0-9-]{36}\.key$/.test(basename(profile.tokenFile))
    ) {
      try {
        unlinkSync(profile.tokenFile);
      } catch {
        /* Connection is saved; cleanup is best effort. */
      }
    }
    ctx.ui.notify(
      "OpenViking connection verified and saved for this Pi profile. Use /memory status to check it or /memory setup to change it.",
      "info",
    );
  } catch (error) {
    if (newTokenFile) {
      try {
        unlinkSync(newTokenFile);
      } catch {
        /* Best effort after a failed settings commit. */
      }
    }
    ctx.ui.notify(
      error instanceof OpenVikingRequestError
        ? `${error.message} Previous settings are unchanged. Run /memory setup to retry.`
        : "OpenViking setup could not be completed. Previous settings are unchanged. Run /memory setup in an interactive terminal to retry.",
      "warning",
    );
  }
}
