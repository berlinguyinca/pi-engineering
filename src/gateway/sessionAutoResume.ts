/** Preflight recovery is passed as a normal CLI prompt, after Pi finishes startup. */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  type SessionEntry,
  SessionManager,
  SettingsManager,
  getAgentDir,
  parseArgs,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";
import { isAutomaticReplayAllowed, parseAdmissionPayload } from "../inference/admissionContract.ts";
import { isRetryableTransportFailure } from "./afterOutputRetry.ts";
import { otherPiProcessesIn } from "./sessionLiveness.ts";
import { recoverableFailure } from "./settleRecovery.ts";

export const SESSION_RECOVERY_MARKER = "[Automatic session recovery]";

/** The failed request explicitly allowed safe replay (an InferWeave replay contract). */
export const SESSION_RECOVERY_PROMPT =
  "[Automatic session recovery] Continue the existing work from this restored session using the current model and preserved tool results. The previous inference request failed before output and explicitly allowed safe replay. Check current state before repeating actions; resume existing mission IDs rather than creating duplicate missions. Respect operator pauses and cancellations.";

/** The last turn ended on a retryable inference failure, with or without partial output. */
export const SESSION_FAILED_TURN_PROMPT =
  "[Automatic session recovery] Continue the existing work from this restored session using the current model and preserved tool results. The previous inference request failed (a dropped stream, timeout or lost capacity) and the session stopped there. Any partial answer above may be incomplete: check current state before repeating actions; resume existing mission IDs rather than creating duplicate missions. Respect operator pauses and cancellations.";

/** The session ends on a tool call or result: Pi was closed or died mid-turn. */
export const SESSION_INTERRUPTED_PROMPT =
  "[Automatic session recovery] Pi stopped while this session was working: it was closed or crashed after a tool call, with no reply after it. Continue the existing work from this restored session. The last tool call may have run fully, partly or not at all, so check current state before repeating any action; resume existing mission IDs rather than creating duplicate missions. Respect operator pauses and cancellations.";

/** Recoveries per operator turn: enough to ride out an outage that outlasts one, never a loop. */
export const MAX_RECOVERIES_PER_TURN = 3;
/** A session whose last event is newer than this may still be live in another terminal. */
export const DEFAULT_MIN_AGE_MS = 10 * 60_000;

export interface SessionRecovery {
  waitMs: number;
  kind: "refused" | "failed-turn" | "interrupted";
  prompt: string;
}

export interface SessionRecoveryOptions {
  /**
   * Tails without the explicit replay contract are left alone until this old:
   * a newer one may still be live in another terminal, where the in-session
   * retry layers are working on it. Two Pi processes must never share a session.
   */
  minAgeMs?: number;
}

function hasMarker(content: unknown): boolean {
  return JSON.stringify(content).includes(SESSION_RECOVERY_MARKER);
}

/**
 * What, if anything, should be sent to continue a restored session.
 *
 * Three tails are recovered: a request refused with an explicit replay contract
 * (the original case), any other retryable inference failure (with or without a
 * partial answer — the in-session retry layers do not survive a restart), and
 * a session that simply stops on a tool call or result because the process
 * died. Completed, aborted and final-refusal tails stay idle, and so does
 * anything that may still be running elsewhere.
 *
 * Automatic recovery prompts are the durable claim: at most
 * MAX_RECOVERIES_PER_TURN follow one operator message.
 */
export function sessionRecovery(
  branch: readonly SessionEntry[],
  now = Date.now(),
  options: SessionRecoveryOptions = {},
): SessionRecovery | undefined {
  const users = [...branch].filter((entry) => entry.type === "message" && entry.message.role === "user");
  if (users.length === 0) return;
  let recoveries = 0;
  for (let i = users.length - 1; i >= 0; i--) {
    const entry = users[i]!;
    if (entry.type !== "message" || !hasMarker(entry.message)) break;
    recoveries++;
  }
  if (recoveries >= MAX_RECOVERIES_PER_TURN) return;
  const last = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role !== "system");
  if (!last || last.type !== "message") return;
  const at = Date.parse(last.timestamp);
  if (!Number.isFinite(at)) return;
  const message = last.message;

  if (message.role === "assistant" && message.stopReason === "error") {
    if (!message.errorMessage) return;
    // The explicit replay contract keeps its exact, narrower rule and wording.
    if (message.content.length === 0) {
      const start = message.errorMessage.indexOf("{");
      const end = message.errorMessage.lastIndexOf("}");
      const info =
        start >= 0 && end > start ? parseAdmissionPayload(message.errorMessage.slice(start, end + 1)) : undefined;
      if (info?.explicitReplayContract) {
        if (!isAutomaticReplayAllowed(info, false)) return;
        return {
          kind: "refused",
          prompt: SESSION_RECOVERY_PROMPT,
          waitMs: Math.max(0, at + (info.retryAfterMs ?? 0) - now),
        };
      }
    }
    const retry =
      recoverableFailure(message) ??
      (isRetryableTransportFailure(message) ? { advertisedWaitMs: undefined } : undefined);
    if (!retry) return;
    if (now - at < (options.minAgeMs ?? DEFAULT_MIN_AGE_MS)) return;
    return {
      kind: "failed-turn",
      prompt: SESSION_FAILED_TURN_PROMPT,
      waitMs: Math.max(0, at + (retry.advertisedWaitMs ?? 0) - now),
    };
  }

  // No error and no reply: the process died with a tool call or result last.
  // Esc writes an "Operation aborted" result for the call in flight: that is the
  // operator stopping the work, not a crash.
  if (message.role === "toolResult" && message.isError && JSON.stringify(message.content).includes("Operation aborted"))
    return;
  const dangling = message.role === "toolResult" || (message.role === "assistant" && message.stopReason === "toolUse");
  if (!dangling) return;
  if (now - at < (options.minAgeMs ?? DEFAULT_MIN_AGE_MS)) return;
  return { kind: "interrupted", prompt: SESSION_INTERRUPTED_PROMPT, waitMs: 0 };
}

export async function prepareSessionAutoResume(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ argv: string[]; waitMs: number; recovering: boolean; kind?: SessionRecovery["kind"]; skipped?: string }> {
  const unchanged = { argv, waitMs: 0, recovering: false };
  if (/^(0|false|off)$/i.test(env.PI_SESSION_AUTO_RESUME ?? "")) return unchanged;
  const args = parseArgs(argv);
  // Explicit input, alternate modes, or ambiguous selections always belong to Pi.
  if (
    args.messages.length ||
    args.fileArgs.length ||
    args.print ||
    args.mode ||
    args.help ||
    args.version ||
    args.export ||
    args.listModels ||
    args.fork ||
    args.resume ||
    // `--continue` with an explicit `--session` is ambiguous: Pi decides.
    (args.continue && args.session) ||
    argv.includes("--") ||
    args.noSession ||
    args.diagnostics.some((d) => d.type === "error")
  )
    return unchanged;
  if (!args.session && !args.continue) return unchanged;
  const expandHome = (path: string) =>
    path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  let path: string | undefined;
  if (args.session && (args.session.includes("/") || args.session.includes("\\") || args.session.endsWith(".jsonl"))) {
    const candidate = resolve(cwd, expandHome(args.session));
    if (existsSync(candidate)) path = candidate;
  } else {
    const configured =
      args.sessionDir ?? env.PI_SESSION_DIR ?? SettingsManager.create(cwd, getAgentDir()).getSessionDir();
    const sessions = await SessionManager.list(cwd, configured ? resolve(cwd, expandHome(configured)) : undefined);
    if (args.session) {
      const matches = sessions.filter((s) => s.id.startsWith(args.session!));
      // Do not guess across projects or among ambiguous prefixes.
      path = matches.find((s) => s.id === args.session)?.path ?? (matches.length === 1 ? matches[0]?.path : undefined);
    } else {
      // `--continue` is Pi's most recently WRITTEN file in this directory (file
      // mtime), which is not the same order as the last message time.
      const mtime = (file: string) => {
        try {
          return statSync(file).mtimeMs;
        } catch {
          return 0;
        }
      };
      path = [...sessions].sort((a, b) => mtime(b.path) - mtime(a.path))[0]?.path;
    }
  }
  if (!path) return unchanged;
  const recovery = sessionRecovery(
    SessionManager.inMemory(cwd, undefined, parseSessionEntries(readFileSync(path, "utf8"))).getBranch(),
    Date.now(),
    { minAgeMs: positiveMs(env.PI_SESSION_AUTO_RESUME_MIN_AGE_MS) },
  );
  if (!recovery) return unchanged;
  // Pin the inspected file so lookup cannot later select a different session.
  // Pi resolves `--session` before `--continue`, so any `-c` stays harmless; it
  // is not stripped, because a flag VALUE can look exactly like it.
  // Live-session check last: it is the only step that touches /proc.
  if (!/^(1|true|on)$/i.test(env.PI_SESSION_AUTO_RESUME_IGNORE_LIVE ?? "")) {
    const header = firstLine(path);
    const sessionCwd = typeof header?.cwd === "string" ? header.cwd : cwd;
    const live = otherPiProcessesIn(sessionCwd);
    if (live.length > 0)
      return { ...unchanged, skipped: `another Pi is running in ${sessionCwd} (pid ${live.join(", ")})` };
  }
  return {
    argv: [...argv, "--session", path, recovery.prompt],
    waitMs: recovery.waitMs,
    recovering: true,
    kind: recovery.kind,
  };
}

function firstLine(path: string): { cwd?: unknown } | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0] ?? "") as { cwd?: unknown };
  } catch {
    return undefined;
  }
}

function positiveMs(value: string | undefined): number | undefined {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
}
