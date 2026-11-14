/**
 * priorartDependency — ensures the priorart MCP server is installed + registered.
 *
 * priorart (github.com/berlinguyinca/pi-priorart) is a REQUIRED EXTERNAL tool for
 * pi-engineering: it forces a prior-art search (own repos + public OSS) before
 * writing non-trivial code. Per EXTERNAL_TOOLS_AND_OWNERSHIP.md, MCP servers are
 * EXTERNAL — pi-engineering owns only registry/configuration/ensure-present, never
 * the tool itself. So this module is the "deployment glue": it makes priorart a
 * durable dependency of pi-engineering by ensuring, on session start, that the
 * binary is present, its config exists, and ~/.pi/agent/mcp.json registers it.
 *
 * Contract:
 *   - Idempotent: checks before writing; never clobbers unrelated mcp.json entries.
 *   - Best-effort + non-throwing: it must NEVER break pi startup.
 *   - No network on a warm start (binary already present).
 *   - Cold start (binary missing): a DETACHED clone+build runs so it never blocks
 *     the session.
 *
 * Paths are injectable for tests; defaults live under the user's $HOME.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";

export const PRIORART_REMOTE = "https://github.com/berlinguyinca/pi-priorart.git";

export interface PriorartPaths {
  /** Installed binary location. */
  bin: string;
  /** priorart config (JSON) location. */
  config: string;
  /** pi user-level MCP config location. */
  mcp: string;
  /** Local source clone location (built from when the binary is missing). */
  source: string;
  /** Canonical git remote used to (re)clone the source. */
  remote: string;
}

export function defaultPriorartPaths(): PriorartPaths {
  const home = homedir();
  return {
    bin: join(home, ".local", "bin", "priorart"),
    config: join(home, ".config", "priorart", "priorart.json"),
    mcp: join(home, ".pi", "agent", "mcp.json"),
    source: join(home, "IdeaProjects", "priorart"),
    remote: PRIORART_REMOTE,
  };
}

export interface EnsurePriorartResult {
  /** True if the binary is present after this call. */
  binaryPresent: boolean;
  /** True if a detached clone+build was kicked off this call. */
  rebuildStarted: boolean;
  /** True if the config file is present after this call. */
  configPresent: boolean;
  /** True if priorart is registered in the MCP config after this call. */
  mcpRegistered: boolean;
  /** Set if an unexpected error escaped (should be rare — all work is guarded). */
  error?: string;
}

export interface EnsurePriorartOptions {
  /**
   * Set false to never spawn the detached clone+build. The rebuild is fire-and-forget and keeps writing into
   * `paths.source` after this call returns, so callers that own a throwaway directory (tests) must opt out or they
   * race their own cleanup.
   */
  rebuild?: boolean;
}

/** Create the priorart config (with own_roots so own-repo search works) if missing. */
function ensureConfig(config: string, sourceRoot: string): boolean {
  try {
    if (existsSync(config)) return true;
    mkdirSync(dirname(config), { recursive: true });
    const cfg = {
      own_roots: [sourceRoot],
      ecosystems: ["py", "js", "rs", "go"],
      github: { own_account: "berlinguyinca", use_own_layer: false },
      ledger_path: join(dirname(config), "ledger", "decisions.jsonl"),
      context7: { enabled: true },
      block_licenses: ["GPL-3.0", "AGPL-3.0"],
      cache_ttl_seconds: 3600,
    };
    writeFileSync(config, `${JSON.stringify(cfg, null, 2)}\n`);
    return existsSync(config);
  } catch {
    return false;
  }
}

/** Register priorart in the MCP config if not already present (never clobber others). */
function ensureMcp(mcp: string, bin: string, config: string): boolean {
  try {
    let doc: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };
    if (existsSync(mcp)) {
      try {
        doc = JSON.parse(readFileSync(mcp, "utf8"));
      } catch {
        doc = { mcpServers: {} };
      }
    }
    if (!doc.mcpServers || typeof doc.mcpServers !== "object") doc.mcpServers = {};
    if (doc.mcpServers.priorart) return true; // already registered — leave it alone
    doc.mcpServers.priorart = { command: bin, args: [config] };
    mkdirSync(dirname(mcp), { recursive: true });
    writeFileSync(mcp, `${JSON.stringify(doc, null, 2)}\n`);
    return existsSync(mcp);
  } catch {
    return false;
  }
}

/**
 * True when `path` is `tmpdir` or lives inside it.
 *
 * `os.tmpdir()` re-reads `$TMPDIR` on every call and, on macOS, the base it returns can be
 * the un-canonicalized `/var/…` spelling of the same directory tests resolve through
 * `/private/var/…`. Compare against both spellings so a path built from either one is seen
 * as ephemeral. The candidate is compared lexically, not realpath'd: `source` may not
 * exist yet (we are deciding whether to create it), so `realpathSync` would throw.
 */
export function isUnderTmpdir(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const bases = new Set<string>([tmpdir()]);
  try {
    bases.add(realpathSync(tmpdir()));
  } catch {
    /* tmpdir always exists in practice; the raw form above is still checked */
  }
  for (const base of bases) {
    if (path === base || path.startsWith(base + sep)) return true;
  }
  return false;
}

/**
 * `PI_ENGINEERING_PRIORART_REBUILD=0|false|no|off` turns the cold-start self-heal off.
 *
 * The self-heal is a detached `git clone` of an external repository followed by `make`, and
 * it is deliberately fire-and-forget: it outlives the call, the session, and any directory
 * the caller owns. `isUnderTmpdir` covers the common ephemeral case (a test HOME under
 * `mkdtemp`), but it cannot see a HOME that lives somewhere else — a checkout-relative test
 * root, a CI home on a data volume, a container whose HOME is `/root`. This is the explicit
 * kill switch for those, and it is what the test bootstrap sets, so no test process can
 * reach the network or write outside its own lifetime no matter where its HOME is.
 * Unset — the production default — keeps the self-heal exactly as it was.
 */
export function rebuildDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.PI_ENGINEERING_PRIORART_REBUILD ?? "").trim().toLowerCase();
  return raw === "0" || raw === "false" || raw === "no" || raw === "off";
}

/** Kick off a DETACHED clone+build (non-blocking) only when the binary is missing. */
function maybeRebuildBinary(p: PriorartPaths): boolean {
  try {
    if (existsSync(p.bin)) return false;
    if (rebuildDisabledByEnv()) return false;
    // The build is fire-and-forget: it outlives this process and keeps writing into
    // `p.source` (and, for a build cache, `$HOME/.cache/…`) after we return. A caller
    // that owns a throwaway `source` — a test that sets HOME under `mkdtemp` and deletes
    // it in `after()` — would delete that tree out from under the still-running build
    // (`rmdir .../go-build/… → ENOTEMPTY`). System temp dirs are exactly those throwaway
    // roots, so never spawn a background build into one. Real homes are not under tmpdir,
    // so the cold-start self-heal is unchanged there.
    if (isUnderTmpdir(p.source)) return false;
    mkdirSync(dirname(p.bin), { recursive: true });
    mkdirSync(p.source, { recursive: true });
    const cmd =
      `([ -d '${p.source}/.git' ] || git clone --depth 1 '${p.remote}' '${p.source}') ` +
      `&& make -C '${p.source}' build && cp '${p.source}/dist/priorart' '${p.bin}'`;
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the priorart dependency is satisfied. Idempotent and non-throwing: safe to
 * call on every pi session start.
 */
export function ensurePriorart(
  paths: PriorartPaths = defaultPriorartPaths(),
  options: EnsurePriorartOptions = {},
): EnsurePriorartResult {
  const result: EnsurePriorartResult = {
    binaryPresent: false,
    rebuildStarted: false,
    configPresent: false,
    mcpRegistered: false,
  };
  try {
    result.configPresent = ensureConfig(paths.config, dirname(paths.source));
    result.mcpRegistered = ensureMcp(paths.mcp, paths.bin, paths.config);
    result.rebuildStarted = options.rebuild === false ? false : maybeRebuildBinary(paths);
    result.binaryPresent = existsSync(paths.bin);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  return result;
}
