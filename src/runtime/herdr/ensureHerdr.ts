/**
 * Opt-in Herdr local-environment helper (herdr spec 03).
 *
 * Pi-Engineering is a thin CONSUMER of Herdr (an external dependency). It does
 * NOT auto-install or auto-start Herdr on any request hot path. This module is
 * an explicit, operator-gated utility for the "Herdr is not local yet" case:
 *
 *  - `detectHerdr` reports whether the binary is on PATH and the server is
 *    reachable (no side effects).
 *  - `herdrInstallHint` returns the documented install guidance.
 *  - `herdrEnsureLocal` performs detection and, ONLY when the operator
 *    explicitly passes an `installCommand` together with `autoInstall: true`,
 *    runs that command (never an embedded/arbitrary command on its own). It then
 *    re-detects and returns the outcome.
 *
 * The normal selection path (`negotiateHerdr`) fails closed with a clear error
 * when Herdr is missing; it never calls this module automatically.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HerdrCli, HerdrStatus } from "./HerdrCli.ts";

const exec = promisify(execFile);

export interface HerdrDetection {
  /** The `herdr` binary was found on PATH. */
  binary: boolean;
  /** The Herdr server responded to a status call. */
  serverRunning: boolean;
  /** Live server status when reachable, else undefined. */
  status?: HerdrStatus;
  /** Human-readable reason when something is missing. */
  reason?: string;
}

export interface HerdrEnsureLocalOptions {
  /** Herdr CLI client (defaults to a RealHerdrCli on the `herdr` binary). */
  cli?: HerdrCli;
  /** Binary name to detect on PATH (default "herdr"). */
  bin?: string;
  /** Minimum protocol to accept (capability negotiation). */
  minProtocol?: number;
  /**
   * Exact install command to run. Ignored unless `autoInstall` is also true.
   * Deliberately operator-supplied so Pi-Engineering never embeds a
   * supply-chain-sensitive install command on its own.
   */
  installCommand?: string;
  /** Explicitly allow running `installCommand`. Defaults to false. */
  autoInstall?: boolean;
  /** Install hint string shown when the binary is missing. */
  installHint?: string;
}

export interface HerdrEnsureResult {
  ok: boolean;
  detection: HerdrDetection;
  action: "ok" | "start-server" | "install-needed" | "installed" | "install-failed";
  message: string;
}

/** Detect binary presence + server reachability without side effects. */
export async function detectHerdr(opts: { bin?: string } = {}): Promise<HerdrDetection> {
  const bin = opts.bin ?? "herdr";
  let binary = true;
  let binaryErr: string | undefined;
  try {
    await exec(bin, ["--version"], { timeout: 10_000 });
  } catch (err) {
    binary = false;
    binaryErr = err instanceof Error ? err.message : String(err);
  }

  if (!binary) {
    return {
      binary: false,
      serverRunning: false,
      reason: `binary '${bin}' not found on PATH${binaryErr ? ` (${binaryErr})` : ""}`,
    };
  }

  // Server reachability is a separate concern from binary presence.
  return { binary: true, serverRunning: false, reason: `binary '${bin}' present but server not yet verified` };
}

/**
 * Opt-in helper: detect Herdr and, only with an explicit operator-supplied
 * install command + `autoInstall: true`, install/start it. Never automatic.
 */
export async function herdrEnsureLocal(opts: HerdrEnsureLocalOptions = {}): Promise<HerdrEnsureResult> {
  const { RealHerdrCli } = await import("./HerdrCli.ts");
  const bin = opts.bin ?? "herdr";
  const cli = opts.cli ?? new RealHerdrCli({ bin });
  const hint =
    opts.installHint ??
    "Herdr is not installed or its server is not running.\n" +
      "Install per your platform's documented Herdr instructions, then start the server.\n" +
      "See docs/specs/pi-engineering-herdr-runtime/HERDR_COMPATIBILITY.md (herdr 0.9.1, socket ~/.config/herdr/herdr.sock).";

  // 1. Binary presence.
  const detection0 = await detectHerdr({ bin });
  if (!detection0.binary) {
    if (opts.installCommand && opts.autoInstall) {
      try {
        // Operator explicitly opted in AND supplied the exact command.
        await exec(opts.installCommand, { timeout: 120_000, shell: true });
      } catch (err) {
        return {
          ok: false,
          detection: detection0,
          action: "install-failed",
          message: `install command failed: ${err instanceof Error ? err.message : err}\n${hint}`,
        };
      }
      const after = await detectHerdr({ bin });
      if (!after.binary) {
        return {
          ok: false,
          detection: after,
          action: "install-failed",
          message: `install ran but '${bin}' still not found.\n${hint}`,
        };
      }
      // Binary present now; fall through to server check below.
      return herdrEnsureLocal({ ...opts, autoInstall: false });
    }
    return { ok: false, detection: detection0, action: "install-needed", message: hint };
  }

  // 2. Server reachability + protocol.
  let status: HerdrStatus | undefined;
  try {
    status = await cli.status();
  } catch (err) {
    return {
      ok: false,
      detection: { ...detection0, serverRunning: false, reason: err instanceof Error ? err.message : String(err) },
      action: "start-server",
      message: `Herdr binary present but server not reachable.\n${hint}`,
    };
  }
  if (opts.minProtocol !== undefined && status.protocol < opts.minProtocol) {
    return {
      ok: false,
      detection: {
        ...detection0,
        serverRunning: true,
        status,
        reason: `protocol ${status.protocol} < minimum ${opts.minProtocol}`,
      },
      action: "start-server",
      message: `Herdr server protocol ${status.protocol} below required minimum ${opts.minProtocol}.`,
    };
  }
  return {
    ok: true,
    detection: {
      ...detection0,
      serverRunning: true,
      status,
      reason: `server reachable (${status.serverVersion}, protocol ${status.protocol})`,
    },
    action: "ok",
    message: `Herdr ready (server ${status.serverVersion}, protocol ${status.protocol}).`,
  };
}
