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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/** Kick off a DETACHED clone+build (non-blocking) only when the binary is missing. */
function maybeRebuildBinary(p: PriorartPaths): boolean {
  try {
    if (existsSync(p.bin)) return false;
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
export function ensurePriorart(paths: PriorartPaths = defaultPriorartPaths()): EnsurePriorartResult {
  const result: EnsurePriorartResult = {
    binaryPresent: false,
    rebuildStarted: false,
    configPresent: false,
    mcpRegistered: false,
  };
  try {
    result.configPresent = ensureConfig(paths.config, dirname(paths.source));
    result.mcpRegistered = ensureMcp(paths.mcp, paths.bin, paths.config);
    result.rebuildStarted = maybeRebuildBinary(paths);
    result.binaryPresent = existsSync(paths.bin);
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  return result;
}
