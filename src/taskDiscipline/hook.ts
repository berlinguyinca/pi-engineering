import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ToolCallEventResult, UserBashEventResult } from "@earendil-works/pi-coding-agent";
import { type TaskContract, contractHash } from "./contract.ts";
/**
 * Pi wiring for the Task Contract gate.
 *
 * Registers its own `tool_call` and `user_bash` handlers so enforcement does not
 * depend on the lifecycle controller (which skips non-mutating tools and can
 * auto-allow when unattended). The contract is read from a host-controlled
 * provider on every call, so an approved amendment takes effect immediately and
 * the model has no tool that can change it.
 */
import { type Decision, type EnforcementMode, type EngineDeps, enforces, evaluate, nodeDeps } from "./engine.ts";

export interface ContractProvider {
  /** The current trusted contract, or undefined when the session has none. */
  current(): TaskContract | undefined;
  /**
   * Why the provider substituted a lockdown contract for the operator's file
   * (unreadable, unparseable), if that is happening right now. Without it a
   * whole session can lose its scope while the agent sees only "(none)" roots.
   */
  lastError?: string;
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

/** What a blocked `tool_call` handler returns to Pi. */
export type Verdict = ToolCallEventResult;

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
    try {
      // recording is best-effort and must never change or break a verdict
      void Promise.resolve(this.o.record?.(d)).catch(() => undefined);
    } catch {
      /* a synchronous recorder failure is ignored */
    }
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
    // Once the incident threshold is crossed the point is an operator decision,
    // not another call in this batch: ask Pi to end the batch after it.
    return this.halted
      ? { block: true, reason: blockMessage(d) + suffix, terminate: true }
      : { block: true, reason: blockMessage(d) + suffix };
  }

  userBash(event: { command: string; cwd: string }): UserBashEventResult | undefined {
    const d = this.check({ toolName: "bash", input: { command: event.command }, cwd: event.cwd });
    if (!d || !d.enforced) return undefined;
    return { result: { output: `${blockMessage(d)}\n`, exitCode: 126, cancelled: false, truncated: false } };
  }
}

/**
 * Typed against Pi's own API, so a signature drift (event fields, result shape,
 * the context argument) is a compile error rather than a silently unchecked
 * cast. Only `on` is needed; the operator-facing notice rides the handler's
 * context (`ctx.ui`), which is where Pi puts the UI surface.
 */
export type DisciplineHost = Pick<ExtensionAPI, "on">;

/** Presentation surface, narrowed to what the gate uses. */
type Notifier = (message: string, level: "info" | "error") => void;

/** Attach the gate to a live Pi session. Order-independent: it never defers to other handlers. */
export function registerTaskDiscipline(pi: DisciplineHost, opts: DisciplineOptions): TaskDiscipline {
  const gate = new TaskDiscipline(opts);
  if (opts.mode === "off") return gate;
  // A provider that cannot honour the operator's file substitutes a lockdown
  // contract: the agent then sees no roots and every call is denied. Two things
  // must say why, because neither surface reaches both readers:
  //   * the session UI (`ctx.ui.notify`) — interactive and RPC only; JSON and
  //     print modes have no UI, so they get the log alone;
  //   * the decision log — a `contract.unavailable` line, because the denials it
  //     produces are indistinguishable from an over-tight contract.
  // Said once per distinct failure (and once when it clears), and presentation
  // never changes a verdict.
  let reported: string | undefined;
  const reportProviderState = (notify: Notifier, toolName: string) => {
    const failure = opts.provider.lastError;
    if (failure && failure !== reported) {
      reported = failure;
      notify(
        `Task Contract is not in force: ${failure}. This session runs in lockdown — no writes, no external effects, no hosts. Fix the contract file, or unset PI_TASK_CONTRACT_FILE to run ungated.`,
        "error",
      );
      recordContractState("contract.unavailable", "deny", failure, toolName);
    } else if (!failure && reported !== undefined) {
      reported = undefined;
      notify("Task Contract is readable again; its authorization is in force.", "info");
      recordContractState("contract.available", "allow", "contract file is readable and valid again", toolName);
    }
  };
  /**
   * The provider hands out the lockdown contract when the file fails, so its
   * identity fields are the ones the surrounding denials were recorded under —
   * the pair reads as one story in the log.
   */
  const recordContractState = (rule: string, verdict: "allow" | "deny", reason: string, toolName: string) => {
    if (!opts.record) return;
    try {
      const c = opts.provider.current();
      if (!c) return;
      const enforcing = enforces(opts.mode, c);
      void opts.record({
        id: `dec_${randomBytes(10).toString("hex")}`,
        taskId: c.taskId,
        revision: c.policyRevision,
        contractHash: contractHash(c),
        toolName,
        verdict,
        enforced: verdict === "deny" ? enforcing : true,
        wouldDeny: verdict === "deny" && !enforcing,
        rule,
        reason,
        next:
          verdict === "deny"
            ? "fix or replace the contract file (the operator's edit), or unset PI_TASK_CONTRACT_FILE to run ungated"
            : "continue within the contract as written",
        effects: [],
        coverage: "full",
        at: new Date().toISOString(),
      });
    } catch {
      /* logging must never change a verdict */
    }
  };
  const notifier =
    (ctx: { ui?: { notify?(m: string, l?: string): void } }): Notifier =>
    (message, level) => {
      try {
        ctx.ui?.notify?.(message, level);
      } catch {
        /* presentation is best-effort */
      }
    };
  // Reported after the check, because the check is what discovers the failure —
  // announcing it before would always describe the previous call's state.
  pi.on("tool_call", (event, ctx) => {
    const result = gate.toolCall(event, ctx.cwd);
    reportProviderState(notifier(ctx as never), event.toolName);
    return result;
  });
  pi.on("user_bash", (event, ctx) => {
    const result = gate.userBash(event);
    reportProviderState(notifier(ctx as never), "user_bash");
    return result;
  });
  return gate;
}
