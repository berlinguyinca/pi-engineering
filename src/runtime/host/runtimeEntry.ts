/**
 * The reloadable runtime module of this package (spec §8).
 *
 * An adapter: the feature code is the existing extension factory in
 * `extensions/index.ts`, unchanged. It is driven through the generation-scoped
 * ExtensionAPI the Host provides, so every handler, command and tool it
 * registers belongs to this generation and nothing it does outlives it.
 *
 * Mission state is durable (mission store, ledger). Stopping a generation
 * replays `session_shutdown`, which closes the EngineeringRuntime and flushes
 * those stores without changing any mission's status. The next generation's
 * `session_start` reopens them, and `MissionSupervisor.reconcileOnStartup()`
 * rehydrates the missions (spec §20, §24).
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import legacyFactory from "../../../extensions/index.ts";
import {
  type EngineeringRuntime,
  PI_ENGINEERING_RUNTIME_API,
  type RuntimeContext,
  type RuntimeHealth,
  type RuntimeQuiesceReason,
  type RuntimeSnapshot,
  type SafePointOptions,
  type SafePointResult,
} from "./contract.ts";
import { discoverMissionHandover } from "./missionHandover.ts";

export const runtimeApi = PI_ENGINEERING_RUNTIME_API;

/** Commands the health check requires (spec §33 "commands registered"). */
export const REQUIRED_COMMANDS = ["engineer", "mission", "plan", "execute", "verify", "review"];
/** Tools the health check requires. */
export const REQUIRED_TOOLS = ["ledger_read"];

type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export async function createRuntime(context: RuntimeContext): Promise<EngineeringRuntime> {
  return new ExtensionGenerationRuntime(context, legacyFactory as unknown as ExtensionFactory);
}

/** Wraps an extension factory as an EngineeringRuntime generation. */
export class ExtensionGenerationRuntime implements EngineeringRuntime {
  private readonly commands = new Set<string>();
  private readonly tools = new Set<string>();
  private started = false;
  private quiesced = false;
  private initErrors: string[] = [];
  private readonly context: RuntimeContext;
  private readonly factory: ExtensionFactory;

  constructor(context: RuntimeContext, factory: ExtensionFactory) {
    this.context = context;
    this.factory = factory;
  }

  async start(): Promise<void> {
    const pi = this.countingApi(this.context.pi);
    await this.factory(pi);
    // Mid-session (a reload): rebuild session plumbing the way a fresh Pi
    // session would. At Pi startup the Host forwards the real session_start.
    if (this.context.session.active()) {
      this.initErrors = await this.context.session.replay("session_start", { type: "session_start", reason: "reload" });
    }
    this.started = true;
  }

  async quiesce(_reason: RuntimeQuiesceReason): Promise<void> {
    // The Host's gate already holds new commands and tool calls; the
    // extension has no other entry point that starts work.
    this.quiesced = true;
  }

  async resume(): Promise<void> {
    this.quiesced = false;
  }

  async waitForSafePoint(options: SafePointOptions = {}): Promise<SafePointResult> {
    const started = Date.now();
    const blocking = () => this.context.operations.active().filter((op) => !op.interruptible);
    while (blocking().length > 0) {
      if (options.signal?.aborted) {
        return { reached: false, reason: "cancelled", blocking: blocking(), waitedMs: Date.now() - started };
      }
      if (options.timeoutMs !== undefined && Date.now() - started >= options.timeoutMs) {
        return { reached: false, reason: "timeout", blocking: blocking(), waitedMs: Date.now() - started };
      }
      options.onWaiting?.(blocking());
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { reached: true, waitedMs: Date.now() - started };
  }

  async snapshot(): Promise<RuntimeSnapshot> {
    const missions = await discoverMissionHandover(this.cwd());
    return {
      generation: this.context.generation,
      activeMissionIds: missions.active,
      pendingMissionIds: missions.pending,
      inferenceWaitMissionIds: missions.inferenceWaits,
      runtimePreferences: { quiesced: this.quiesced },
      createdAt: new Date().toISOString(),
    };
  }

  async stop(): Promise<void> {
    if (!this.context.session.active()) return;
    // The extension clears the terminal on session_shutdown, which is right
    // when Pi exits and wrong mid-session: the TUI keeps drawing.
    const previous = process.env.PI_CLEAR_ON_EXIT;
    process.env.PI_CLEAR_ON_EXIT = "0";
    try {
      const failures = await this.context.session.replay("session_shutdown", {
        type: "session_shutdown",
        reason: "reload",
      });
      if (failures.length > 0) throw new Error(`session shutdown failed: ${failures.join("; ")}`);
    } finally {
      if (previous === undefined) delete process.env.PI_CLEAR_ON_EXIT;
      else process.env.PI_CLEAR_ON_EXIT = previous;
    }
  }

  async health(): Promise<RuntimeHealth> {
    const checks: RuntimeHealth["checks"] = [];
    checks.push({ name: "runtime module loaded", ok: true });
    checks.push({ name: "start() completed", ok: this.started });
    const missingCommands = REQUIRED_COMMANDS.filter((c) => !this.commands.has(c));
    checks.push({
      name: "commands registered",
      ok: missingCommands.length === 0,
      ...(missingCommands.length ? { detail: `missing ${missingCommands.join(", ")}` } : {}),
    });
    const missingTools = REQUIRED_TOOLS.filter((t) => !this.tools.has(t));
    checks.push({
      name: "tools registered",
      ok: missingTools.length === 0,
      ...(missingTools.length ? { detail: `missing ${missingTools.join(", ")}` } : {}),
    });
    checks.push({
      name: "no initialization exception",
      ok: this.initErrors.length === 0,
      ...(this.initErrors.length ? { detail: this.initErrors.join("; ") } : {}),
    });
    const stateDir = join(this.cwd(), ".pi-eng");
    let readable = true;
    let detail: string | undefined;
    if (existsSync(stateDir)) {
      try {
        readdirSync(stateDir);
      } catch (error) {
        readable = false;
        detail = error instanceof Error ? error.message : String(error);
      }
    }
    checks.push({ name: "persistent state readable", ok: readable, ...(detail ? { detail } : {}) });
    // A handover must not turn a mission waiting for inference capacity into a
    // failure (spec §41). The durable store is the witness.
    const waits = this.context.restore?.inferenceWaitMissionIds ?? [];
    if (waits.length > 0) {
      const facts = await discoverMissionHandover(this.cwd());
      const lost = waits.filter((id) => ["FAILED", "CANCELED"].includes(facts.statuses[id] ?? ""));
      checks.push({
        name: "inference-wait missions preserved",
        ok: lost.length === 0,
        ...(lost.length ? { detail: `failed during handover: ${lost.join(", ")}` } : {}),
      });
    }
    // Inference availability is deliberately NOT a health check (spec §33).
    return { healthy: checks.every((c) => c.ok), checks };
  }

  private cwd(): string {
    const ctx = this.context.latestContext() as { cwd?: string } | undefined;
    return ctx?.cwd ?? process.cwd();
  }

  /** Observe what the factory registers, for the health check. */
  private countingApi(pi: ExtensionAPI): ExtensionAPI {
    return new Proxy(pi as unknown as Record<string | symbol, unknown>, {
      get: (target, prop) => {
        if (prop === "registerCommand") {
          return (name: string, options: unknown) => {
            this.commands.add(name);
            return (target.registerCommand as (n: string, o: unknown) => void)(name, options);
          };
        }
        if (prop === "registerTool") {
          return (tool: { name: string }) => {
            this.tools.add(tool.name);
            return (target.registerTool as (t: unknown) => void)(tool);
          };
        }
        return Reflect.get(target, prop, target);
      },
    }) as unknown as ExtensionAPI;
  }
}
