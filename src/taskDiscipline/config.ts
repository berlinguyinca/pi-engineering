/**
 * Host-side configuration for the Task Contract gate.
 *
 *   PI_TASK_DISCIPLINE       off (default) | audit_only | enforce_diagnostic | enforce_all
 *   PI_TASK_CONTRACT_FILE    path to the trusted contract JSON, written by the operator/control plane
 *   PI_TASK_DISCIPLINE_LOG   append-only JSONL decision log (default: <contract dir>/decisions.jsonl)
 *
 * The contract file and the log are protected from agent writes automatically.
 * An unreadable or invalid contract in an enforcing mode locks the session down
 * (nothing readable, nothing writable) instead of silently allowing everything.
 */
import { appendFileSync, mkdirSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactSecrets } from "../platform/redact.ts";
import { type TaskContract, parseContract } from "./contract.ts";
import type { Decision, EnforcementMode } from "./engine.ts";
import type { ContractProvider, DisciplineOptions } from "./hook.ts";
import { isWithin, resolvePath } from "./pathScope.ts";

const MODES: EnforcementMode[] = ["off", "audit_only", "enforce_diagnostic", "enforce_all"];

export function resolveMode(env: NodeJS.ProcessEnv = process.env): EnforcementMode {
  const raw = (env.PI_TASK_DISCIPLINE ?? "off").trim().toLowerCase();
  return (MODES as string[]).includes(raw) ? (raw as EnforcementMode) : "enforce_all"; // an unrecognised value must not weaken enforcement
}

const lockdown = (reason: string): TaskContract => ({
  taskId: "lockdown",
  objective: `contract unavailable: ${reason}`,
  mode: "investigation",
  policyRevision: 1,
  readRoots: [],
  writeRoots: [],
  allowedHosts: [],
  externalEffects: [],
  acceptanceCriteria: ["restore a valid task contract"],
});

export class FileContractProvider implements ContractProvider {
  private cached: { mtimeMs: number; size: number; contract: TaskContract } | undefined;
  lastError: string | undefined;

  private readonly file: string;
  private readonly extraProtected: string[];

  constructor(file: string, extraProtected: string[] = []) {
    this.file = file;
    this.extraProtected = extraProtected;
  }

  current(): TaskContract {
    try {
      const st = statSync(this.file);
      if (this.cached && this.cached.mtimeMs === st.mtimeMs && this.cached.size === st.size)
        return this.cached.contract;
      const parsed = parseContract(JSON.parse(readFileSync(this.file, "utf8")));
      const contract: TaskContract = { ...parsed, protectedPaths: this.protected(parsed) };
      this.cached = { mtimeMs: st.mtimeMs, size: st.size, contract };
      this.lastError = undefined;
      return contract;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return lockdown(this.lastError);
    }
  }

  /**
   * The contract file and the decision log are always protected. The directory
   * is protected too — editors drop temp copies next to the file, and a stray
   * `contract.json.bak` should not be agent-writable — except when that
   * directory *is* a writable root: protecting it would then swallow the whole
   * tree the task is allowed to write in, which is exactly what a scratch root
   * colocated with the contract means. There, only the files themselves are
   * protected.
   */
  private protected(parsed: TaskContract): string[] {
    const dir = dirname(this.file);
    const real = (p: string) => {
      const r = resolvePath(p, dir);
      return r.ok ? r.path : p;
    };
    const dirReal = real(dir);
    const writable = [...parsed.writeRoots, ...(parsed.scratchRoots ?? [])].map(real);
    const dirIsWritable = writable.some((root) => isWithin(dirReal, root) || isWithin(root, dirReal));
    const roots = dirIsWritable ? [] : [dirReal];
    return [...new Set([...(parsed.protectedPaths ?? []), this.file, ...this.extraProtected, ...roots])];
  }
}

export function appendDecision(file: string, d: Decision): void {
  mkdirSync(dirname(file), { recursive: true });
  const line = {
    ...d,
    command: d.command === undefined ? undefined : redactSecrets(d.command),
    reason: redactSecrets(d.reason),
  };
  appendFileSync(file, `${JSON.stringify(line)}\n`);
}

/** Build gate options from the environment; undefined when the feature is off. */
export function disciplineFromEnv(env: NodeJS.ProcessEnv = process.env): DisciplineOptions | undefined {
  const mode = resolveMode(env);
  if (mode === "off") return undefined;
  const file = env.PI_TASK_CONTRACT_FILE;
  if (!file) {
    // Enforcing without a contract would be a silent no-op: lock down instead.
    const provider: ContractProvider = { current: () => lockdown("PI_TASK_CONTRACT_FILE is not set") };
    return { mode, provider };
  }
  const log = env.PI_TASK_DISCIPLINE_LOG ?? join(dirname(file), "decisions.jsonl");
  const provider = new FileContractProvider(file, [log]);
  return {
    mode,
    provider,
    record: (d) => {
      try {
        appendDecision(log, d);
      } catch {
        /* logging must never change a verdict */
      }
    },
  };
}
