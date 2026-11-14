import { type ChildProcess, spawn } from "node:child_process";
import { resolveOmpAdapterConfig } from "./config.ts";
import { decodeNegotiateResponse, decodeReadyFrame, encodeNegotiateRequest, parseFrameLine } from "./frames.ts";
import { OMP_PIN_MANIFEST, isVersionPinned, parseSemVer, parseVersionOutput } from "./manifest.ts";
import { buildCapabilityReport, selectProtocol } from "./report.ts";
import {
  type OmpLaunchSpec,
  type OmpNegotiationResult,
  type OmpPinManifest,
  type RpcProtocolVersion,
  UnavailableReason,
} from "./types.ts";

const NEGOTIATE_ID = "pe-negotiate-1";
const KILL_GRACE_MS = 2_000;
const EXIT_SETTLE_DEFER_MS = 100;
const STDERR_TAIL_BYTES = 2_048;
const MAX_VERSION_OUTPUT_BYTES = 4_096;
/** Matches omp's own MAX_RPC_FRAME_BYTES; a longer line cannot be a valid frame. */
const MAX_FRAME_LINE_BYTES = 1024 * 1024;

type Outcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "fail"; readonly reason: UnavailableReason; readonly detail: string };

export interface NegotiateOptions {
  readonly launch: OmpLaunchSpec;
  /** Overall budget for the whole negotiation (version probe + RPC handshake). */
  readonly timeoutMs: number;
  readonly manifest?: OmpPinManifest;
  readonly env?: NodeJS.ProcessEnv;
  /** Working directory for the child; defaults to the current one. */
  readonly cwd?: string;
}

const unavailable = (reason: UnavailableReason, detail: string): OmpNegotiationResult => ({
  kind: "unavailable",
  reason,
  detail,
});

/**
 * Children are spawned as their own process-group leader (POSIX only; Windows
 * is unsupported by this spike) so a shell-forked grandchild that inherited the
 * stdio pipes can be signalled too. ESRCH (group already gone) is tolerated.
 */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Kill the whole process group, wait for the direct child's `exit` (never `close`), then drop the pipes. */
async function terminate(child: ChildProcess): Promise<void> {
  if (!hasExited(child)) {
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    signalTree(child, "SIGTERM");
    const grace = new Promise<void>((resolve) => setTimeout(resolve, KILL_GRACE_MS).unref());
    await Promise.race([exited, grace]);
    if (!hasExited(child)) {
      signalTree(child, "SIGKILL");
      await exited;
    }
  }
  // Sweep stragglers (grandchildren) that outlived the direct child.
  signalTree(child, "SIGKILL");
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * Run one child process under a deadline. `onStart` wires protocol logic and
 * calls `settle` exactly once; the child is always reaped before returning.
 */
function runChild<T>(
  launch: OmpLaunchSpec,
  extraArgs: readonly string[],
  deadlineMs: number,
  opts: Pick<NegotiateOptions, "env" | "cwd">,
  onStart: (child: ChildProcess, settle: (outcome: Outcome<T>) => void, stderrTail: () => string) => void,
): Promise<Outcome<T>> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(launch.command, [...launch.args, ...extraArgs], {
        stdio: ["pipe", "pipe", "pipe"],
        env: opts.env,
        cwd: opts.cwd,
        detached: process.platform !== "win32",
      });
    } catch (error) {
      resolve({ kind: "fail", reason: UnavailableReason.Crashed, detail: `spawn threw: ${String(error)}` });
      return;
    }
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    child.stdin?.on("error", () => {});
    let done = false;
    const timer = setTimeout(
      () => settle({ kind: "fail", reason: UnavailableReason.Timeout, detail: `no result within ${deadlineMs}ms` }),
      Math.max(1, deadlineMs),
    );
    const settle = (outcome: Outcome<T>): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      void terminate(child).then(() => resolve(outcome));
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(
        error.code === "ENOENT" || error.code === "EACCES"
          ? { kind: "fail", reason: UnavailableReason.BinaryAbsent, detail: `${launch.command}: ${error.code}` }
          : { kind: "fail", reason: UnavailableReason.Crashed, detail: `spawn error: ${error.message}` },
      );
    });
    // `exit`, not `close`: a grandchild holding the pipes must not delay settlement.
    // The short defer lets already-buffered stdout (e.g. the version line) settle first.
    child.once("exit", (code, signal) => {
      setTimeout(() => {
        settle({
          kind: "fail",
          reason: UnavailableReason.Crashed,
          detail: `exited before completing (code=${code}, signal=${signal}) stderr=${stderr.trim() || "<empty>"}`,
        });
      }, EXIT_SETTLE_DEFER_MS);
    });
    onStart(child, settle, () => stderr);
  });
}

function probeVersion(opts: NegotiateOptions, deadlineMs: number): Promise<Outcome<string>> {
  return runChild<string>(opts.launch, ["--version"], deadlineMs, opts, (child, settle) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.length > MAX_VERSION_OUTPUT_BYTES) {
        settle({
          kind: "fail",
          reason: UnavailableReason.VersionUnreadable,
          detail: `--version output exceeds ${MAX_VERSION_OUTPUT_BYTES} bytes`,
        });
      }
    });
    child.stdout?.once("end", () => {
      // Empty output means the process died or said nothing; the close handler reports that as a crash.
      if (out.trim() === "") return;
      const version = parseVersionOutput(out);
      settle(
        version === null
          ? {
              kind: "fail",
              reason: UnavailableReason.VersionUnreadable,
              detail: `unrecognized --version output: ${out.trim().slice(0, 200)}`,
            }
          : { kind: "ok", value: version },
      );
    });
  });
}

function handshake(
  opts: NegotiateOptions,
  manifest: OmpPinManifest,
  ompVersion: string,
  deadlineMs: number,
): Promise<Outcome<OmpNegotiationResult>> {
  return runChild<OmpNegotiationResult>(
    opts.launch,
    ["--mode", "rpc", "--no-session"],
    deadlineMs,
    opts,
    (child, settle) => {
      if (!child.stdout) return;
      let ready: ReturnType<typeof decodeReadyFrame> = null;
      const finish = (result: OmpNegotiationResult): void => settle({ kind: "ok", value: result });
      const onLine = (line: string) => {
        const frame = parseFrameLine(line);
        if (frame === null) {
          // stdout is the protocol channel; a non-JSON line before ready means this is not an RPC server.
          if (ready === null)
            finish(unavailable(UnavailableReason.MalformedFrame, `non-JSON line before ready: ${line.slice(0, 120)}`));
          return;
        }
        if (ready === null) {
          if (frame.type !== "ready") return;
          ready = decodeReadyFrame(frame);
          if (ready === null) return finish(unavailable(UnavailableReason.MalformedFrame, "malformed ready frame"));
          const selected = selectProtocol(ready, manifest);
          if (selected === null) {
            return finish(
              unavailable(
                UnavailableReason.ProtocolMismatch,
                `runtime supports [${ready.supportedProtocolVersions.join(",")}], adapter accepts [${manifest.acceptedProtocolVersions.join(",")}]`,
              ),
            );
          }
          if (selected === 1) return finish({ kind: "available", report: buildCapabilityReport(ompVersion, ready, 1) });
          child.stdin?.write(encodeNegotiateRequest(NEGOTIATE_ID, selected));
          return;
        }
        const response = decodeNegotiateResponse(frame, NEGOTIATE_ID);
        if (response === null) return;
        if (response.kind === "rejected") {
          return finish(unavailable(UnavailableReason.ProtocolMismatch, response.error));
        }
        if (response.protocolVersion !== 1 && response.protocolVersion !== 2) {
          return finish(
            unavailable(UnavailableReason.ProtocolMismatch, `runtime echoed protocol ${response.protocolVersion}`),
          );
        }
        const negotiated: RpcProtocolVersion = response.protocolVersion;
        finish({ kind: "available", report: buildCapabilityReport(ompVersion, ready, negotiated) });
      };
      // Manual line splitting (not readline) so an unterminated line cannot grow without bound.
      let pending = "";
      child.stdout.on("data", (chunk: Buffer) => {
        pending += chunk.toString("utf8");
        let newline = pending.indexOf("\n");
        while (newline !== -1) {
          onLine(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
        if (pending.length > MAX_FRAME_LINE_BYTES) {
          pending = "";
          finish(unavailable(UnavailableReason.MalformedFrame, `frame line exceeds ${MAX_FRAME_LINE_BYTES} bytes`));
        }
      });
    },
  );
}

/**
 * Probe a real OMP binary: version check against the pin manifest, then the
 * RPC `ready` + `negotiate_protocol` handshake. Never throws; every failure is
 * an explicit `unavailable` result so the caller can use the legacy path.
 */
export async function negotiateOmp(opts: NegotiateOptions): Promise<OmpNegotiationResult> {
  const manifest = opts.manifest ?? OMP_PIN_MANIFEST;
  const started = Date.now();
  const remaining = (): number => opts.timeoutMs - (Date.now() - started);
  try {
    const version = await probeVersion(opts, remaining());
    if (version.kind === "fail") return unavailable(version.reason, version.detail);
    const parsed = parseSemVer(version.value);
    if (parsed === null || !isVersionPinned(parsed, manifest)) {
      return unavailable(
        UnavailableReason.VersionMismatch,
        `omp ${version.value} outside pinned range [${manifest.minVersion.major}.${manifest.minVersion.minor}.${manifest.minVersion.patch}, ${manifest.maxVersionExclusive.major}.${manifest.maxVersionExclusive.minor}.${manifest.maxVersionExclusive.patch})`,
      );
    }
    const result = await handshake(opts, manifest, version.value, remaining());
    return result.kind === "ok" ? result.value : unavailable(result.reason, result.detail);
  } catch (error) {
    return unavailable(UnavailableReason.Crashed, `adapter internal error: ${String(error)}`);
  }
}

/**
 * Env-driven entry point.
 *
 * KNOWN RISK: the full parent environment is forwarded to the operator-pinned
 * binary (no allowlist), including any secrets in `process.env`. Only point
 * PI_ENGINEERING_OMP_BIN at a binary you trust. Behavior intentionally unchanged.
 * Disabled (default) returns immediately without spawning anything.
 */
export async function negotiateOmpFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<OmpNegotiationResult> {
  const config = resolveOmpAdapterConfig(env);
  if (!config.enabled) return unavailable(UnavailableReason.Disabled, "PI_ENGINEERING_OMP_ADAPTER not enabled");
  return negotiateOmp({ launch: config.launch, timeoutMs: config.timeoutMs, env });
}
