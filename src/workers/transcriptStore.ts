/**
 * Persisted worker transcripts.
 *
 * One JSONL file per worker execution under the machine-local runtime state
 * directory (never inside the repo or a candidate worktree):
 *
 *   <state>/worktrees/<worktree-id>/transcripts/<mission>/<execution>.jsonl
 *
 * Records carry role, tool calls/results (truncated), per-turn stop reason,
 * tokens, model and timestamps. Secrets are redacted; the file is size-capped
 * and rotated to `<file>.1` (one predecessor kept).
 *
 *   PI_WORKER_TRANSCRIPTS=on|off          (default on)
 *   PI_WORKER_TRANSCRIPT_MAX_BYTES        (default 5 MiB per file)
 *   PI_WORKER_TRANSCRIPT_TOOL_CHARS       (default 4000 chars per tool arg/result)
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "../security/SecurityPolicy.ts";

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TOOL_CHARS = 4000;

export function transcriptsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.PI_WORKER_TRANSCRIPTS?.trim().toLowerCase();
  return !(raw === "off" || raw === "0" || raw === "false");
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** A path segment that cannot escape its directory. */
function segment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "_";
}

export function transcriptPath(worktreeDir: string, missionId: string, executionId: string): string {
  return join(worktreeDir, "transcripts", segment(missionId), `${segment(executionId)}.jsonl`);
}

/** Redact secrets and cap the length of any string leaf. */
function scrub(value: unknown, maxChars: number): unknown {
  if (typeof value === "string") {
    const text = redactSecrets(value);
    return text.length > maxChars ? `${text.slice(0, maxChars)}…[truncated ${text.length - maxChars} chars]` : text;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, maxChars));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, maxChars)]));
  }
  return value;
}

export class TranscriptWriter {
  private readonly maxBytes = envInt("PI_WORKER_TRANSCRIPT_MAX_BYTES", DEFAULT_MAX_BYTES);
  private readonly maxChars = envInt("PI_WORKER_TRANSCRIPT_TOOL_CHARS", DEFAULT_TOOL_CHARS);

  readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  /** Append one record. Never throws: a transcript must not break the run. */
  write(record: Record<string, unknown>): void {
    try {
      let line = `${JSON.stringify(scrub({ at: new Date().toISOString(), ...record }, this.maxChars))}\n`;
      if (Buffer.byteLength(line) > this.maxBytes) {
        line = `${JSON.stringify({ at: new Date().toISOString(), kind: record.kind, truncated: true })}\n`;
      }
      mkdirSync(dirname(this.file), { recursive: true });
      try {
        if (statSync(this.file).size + Buffer.byteLength(line) > this.maxBytes) renameSync(this.file, `${this.file}.1`);
      } catch {
        // No file yet.
      }
      appendFileSync(this.file, line, "utf8");
    } catch {
      // Observer only.
    }
  }
}
