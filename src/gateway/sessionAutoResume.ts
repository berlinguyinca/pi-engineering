/** Preflight recovery is passed as a normal CLI prompt, after Pi finishes startup. */
import { existsSync, readFileSync } from "node:fs";
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

export const SESSION_RECOVERY_PROMPT =
  "[Automatic session recovery] Continue the existing work from this restored session using the current model and preserved tool results. The previous inference request failed before output and explicitly allowed safe replay. Check current state before repeating actions; resume existing mission IDs rather than creating duplicate missions. Respect operator pauses and cancellations.";

/** A recovery prompt is itself the durable claim: never recover it again on restart. */
export function sessionRecovery(branch: readonly SessionEntry[], now = Date.now()): { waitMs: number } | undefined {
  const latestUser = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
  if (!latestUser || latestUser.type !== "message" || latestUser.message.role !== "user") return;
  if (JSON.stringify(latestUser.message.content).includes("[Automatic session recovery]")) return;
  const last = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role !== "system");
  if (!last || last.type !== "message" || last.message.role !== "assistant") return;
  const message = last.message;
  if (message.stopReason !== "error" || !message.errorMessage || message.content.length !== 0) return;
  const start = message.errorMessage.indexOf("{");
  const end = message.errorMessage.lastIndexOf("}");
  if (start < 0 || end <= start) return;
  const info = parseAdmissionPayload(message.errorMessage.slice(start, end + 1));
  if (!info?.explicitReplayContract || !isAutomaticReplayAllowed(info, false)) return;
  const failedAt = Date.parse(last.timestamp);
  if (!Number.isFinite(failedAt)) return;
  return { waitMs: Math.max(0, failedAt + (info.retryAfterMs ?? 0) - now) };
}

export async function prepareSessionAutoResume(
  argv: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ argv: string[]; waitMs: number; recovering: boolean }> {
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
    args.continue ||
    argv.includes("--") ||
    args.noSession ||
    args.diagnostics.some((d) => d.type === "error")
  )
    return unchanged;
  if (!args.session) return unchanged;
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
    } else path = sessions[0]?.path;
  }
  if (!path) return unchanged;
  const recovery = sessionRecovery(
    SessionManager.inMemory(cwd, undefined, parseSessionEntries(readFileSync(path, "utf8"))).getBranch(),
  );
  if (!recovery) return unchanged;
  // Preserve all original flag/value pairs; Pi uses the last --session value.
  // Pin the inspected file so lookup cannot later select a different session.
  return { argv: [...argv, "--session", path, SESSION_RECOVERY_PROMPT], waitMs: recovery.waitMs, recovering: true };
}
