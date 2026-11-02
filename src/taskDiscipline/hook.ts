import type { TaskContract } from "./contract.ts";
/**
 * Pi wiring for the Task Contract gate.
 *
 * Registers its own `tool_call` and `user_bash` handlers so enforcement does not
 * depend on the lifecycle controller (which skips non-mutating tools and can
 * auto-allow when unattended). The contract is read from a host-controlled
 * provider on every call, so an approved amendment takes effect immediately and
 * the model has no tool that can change it.
 */
import { type Decision, type EnforcementMode, type EngineDeps, evaluate, nodeDeps } from "./engine.ts";

export interface ContractProvider {
  /** The current trusted contract, or undefined when the session has none. */
  current(): TaskContract | undefined;
}

export interface DisciplineOptions {
  mode: EnforcementMode;
  provider: ContractProvider;
  trustedTools?: string[];
  deps?: EngineDeps;
  /** Every decision (allow, deny, would-deny) is delivered here; failures never alter the verdict. */
  record?: (d: Decision) => void | Promise<void>;
  /** Called when the same rule keeps blocking: the agent loop should stop and surface an incident. */
  onIncident?: (info: { rule: string; count: number; decision: Decision }) => void;
  /** Blocks of the same rule inside the rolling window before an incident is raised. */
  incidentThreshold?: number;
  incidentWindow?: number;
}

export interface Verdict {
  block?: boolean;
  reason?: string;
}

export function blockMessage(d: Decision): string {
  const head = d.enforced
    ? `Blocked by the task contract (${d.rule}, decision ${d.id}): ${d.reason}.`
    : `Would be blocked by the task contract (${d.rule}); audit-only, not enforced.`;
  return `${head}${d.next ? ` Continue with: ${d.next}.` : ""} This action was not executed. Do not retry it through another command, tool or host; scope can only be changed by the operator.`;
}

export class TaskDiscipline {
  private readonly o: DisciplineOptions;
  private readonly recent: string[] = [];
  private readonly deps: EngineDeps;
  halted = false;

  constructor(o: DisciplineOptions) {
    this.o = o;
    this.deps = o.deps ?? nodeDeps();
  }

  /** Evaluate one call; fail closed on internal errors when enforcing. */
  check(call: { toolName: string; toolCallId?: string; input: unknown; cwd: string }): Decision | undefined {
    const { mode } = this.o;
    if (mode === "off") return undefined;
    const contract = this.o.provider.current();
    if (!contract) {
      if (mode === "enforce_all" || mode === "enforce_diagnostic") return this.noContract(call);
      return undefined;
    }
    let d: Decision;
    try {
      d = evaluate(contract, call, { mode, trustedTools: this.o.trustedTools, deps: this.deps });
    } catch (err) {
      d = this.failClosed(contract, call, err);
    }
    this.track(d);
    void Promise.resolve(this.o.record?.(d)).catch(() => undefined);
    return d;
  }

  private noContract(call: { toolName: string; toolCallId?: string; input: unknown; cwd: string }):
    | Decision
    | undefined {
    // Sessions without a contract keep their existing behaviour; strictness is opt-in per mission.
    void call;
    return undefined;
  }

  private failClosed(c: TaskContract, call: { toolName: string; toolCallId?: string }, err: unknown): Decision {
    const enforced =
      this.o.mode === "enforce_all" ||
      (this.o.mode === "enforce_diagnostic" && (c.mode === "investigation" || c.mode === "review"));
    return {
      id: `dec_error_${Date.now().toString(36)}`,
      taskId: c.taskId,
      revision: c.policyRevision,
      contractHash: "",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      verdict: "deny",
      enforced,
      wouldDeny: !enforced,
      rule: "engine.error",
      reason: `policy evaluation failed (${err instanceof Error ? err.message : String(err)}); failing closed`,
      next: "continue with read-only local analysis",
      effects: [],
      coverage: "full",
      at: new Date().toISOString(),
    };
  }

  private track(d: Decision) {
    if (d.verdict !== "deny") {
      this.recent.push("");
    } else {
      this.recent.push(d.rule);
    }
    const window = this.o.incidentWindow ?? 10;
    while (this.recent.length > window) this.recent.shift();
    if (d.verdict === "deny" && d.enforced) {
      const count = this.recent.filter((r) => r === d.rule).length;
      if (count > (this.o.incidentThreshold ?? 3)) {
        this.halted = true;
        this.o.onIncident?.({ rule: d.rule, count, decision: d });
      }
    }
  }

  toolCall(event: { toolName: string; toolCallId?: string; input: unknown }, cwd: string): Verdict | undefined {
    const d = this.check({ toolName: String(event.toolName), toolCallId: event.toolCallId, input: event.input, cwd });
    if (!d || !d.enforced) return undefined;
    const suffix = this.halted
      ? " Repeated blocks: the policy incident has been surfaced to the operator; stop and report what is blocking you."
      : "";
    return { block: true, reason: blockMessage(d) + suffix };
  }

  userBash(event: { command: string; cwd: string }):
    | { result: { output: string; exitCode: number; cancelled: boolean; truncated: boolean } }
    | undefined {
    const d = this.check({ toolName: "bash", input: { command: event.command }, cwd: event.cwd });
    if (!d || !d.enforced) return undefined;
    return { result: { output: `${blockMessage(d)}\n`, exitCode: 126, cancelled: false, truncated: false } };
  }
}

interface HookHost {
  on(
    event: "tool_call",
    handler: (event: { toolName: string; toolCallId?: string; input: unknown }, ctx: { cwd: string }) => unknown,
  ): unknown;
  on(event: "user_bash", handler: (event: { command: string; cwd: string }) => unknown): unknown;
}

/** Attach the gate to a live Pi session. Order-independent: it never defers to other handlers. */
export function registerTaskDiscipline(pi: HookHost, opts: DisciplineOptions): TaskDiscipline {
  const gate = new TaskDiscipline(opts);
  if (opts.mode === "off") return gate;
  pi.on("tool_call", (event, ctx) => gate.toolCall(event, ctx.cwd));
  pi.on("user_bash", (event) => gate.userBash(event));
  return gate;
}
