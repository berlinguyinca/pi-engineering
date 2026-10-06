/**
 * The Host's single point of contact with Pi's ExtensionAPI.
 *
 * Pi cannot unregister commands or tools, and it chains event results handler
 * by handler. So the bridge registers with Pi ONCE and forwards (see
 * docs/specs/live-self-update-hot-reload-notes.md):
 *
 *   - events: slot k of event e forwards to handler k of the generation
 *     currently receiving events. A slot is registered the first time any
 *     generation needs it and never again, so Pi's handler count is the maximum
 *     over generations, never the sum.
 *   - commands / tools: one forwarder per name, dispatching at call time.
 *   - action methods: fenced. A retired generation's late calls do nothing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StaleGenerationError } from "./contract.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type CommandOptions = {
  description?: string;
  getArgumentCompletions?: (prefix: string) => unknown;
  handler: (args: string, ctx: unknown) => Promise<void>;
};
type ToolDef = { name: string; execute?: (...args: unknown[]) => unknown; [key: string]: unknown };

interface GenerationTable {
  handlers: Map<string, Handler[]>;
  commands: Map<string, CommandOptions>;
  tools: Map<string, ToolDef>;
  fencedCalls: number;
}

/** How the bridge learns where to send things. Implemented by the RuntimeHost. */
export interface BridgeTarget {
  /** The generation that should receive Pi traffic now, a promise of it during handover, or undefined. */
  dispatchGeneration(): number | undefined | Promise<number | undefined>;
  /** Hold new work while a handover is running. */
  whenOpen(): Promise<void>;
  /** Track a forwarded command/tool as an operation of `generation`. */
  track<T>(generation: number, type: "command" | "tool", label: string, work: () => Promise<T>): Promise<T>;
  /** False once the generation has been retired. */
  isLive(generation: number): boolean;
}

/** Methods that register something. Passed through, keyed by Pi, overwrite-on-reregister. */
const PASSTHROUGH_REGISTRATIONS = new Set([
  "registerShortcut",
  "registerFlag",
  "registerMessageRenderer",
  "registerMarkdownTransformer",
  "registerEntryRenderer",
  "registerProvider",
  "unregisterProvider",
]);

/** Pure reads: never fenced. */
const READS = new Set([
  "getFlag",
  "getSessionName",
  "getActiveTools",
  "getAllTools",
  "getCommands",
  "getThinkingLevel",
]);

/** Actions that return a promise: a stale call rejects instead of returning undefined. */
const PROMISE_ACTIONS = new Set(["setModel", "exec"]);

export class PiBridge {
  private readonly slots = new Map<string, number>();
  private readonly tables = new Map<number, GenerationTable>();
  private readonly commandForwarders = new Set<string>();
  private readonly toolForwarders = new Set<string>();
  private readonly hostCommands = new Set<string>();
  private readonly hasOn: boolean;

  private readonly hostRouted: Set<string>;

  /**
   * @param hostRouted events the Host delivers itself (via `replay`); a
   *   generation's handlers for them are recorded but never slotted.
   */
  private readonly pi: ExtensionAPI;
  private readonly target: BridgeTarget;

  constructor(pi: ExtensionAPI, target: BridgeTarget, hostRouted: Iterable<string> = []) {
    this.pi = pi;
    this.target = target;
    this.hasOn = typeof (pi as { on?: unknown }).on === "function";
    this.hostRouted = new Set(hostRouted);
  }

  /** Whether the Pi host delivers events at all (stub hosts do not). */
  hasPiEvents(): boolean {
    return this.hasOn;
  }

  /** Real handlers registered with Pi for `event` (or all events). */
  realHandlerCount(event?: string): number {
    if (event !== undefined) return this.slots.get(event) ?? 0;
    let n = 0;
    for (const count of this.slots.values()) n += count;
    return n;
  }

  realCommandNames(): string[] {
    return [...this.hostCommands, ...this.commandForwarders];
  }

  /** A command the Host itself owns; never routed to a generation first. */
  registerHostCommand(name: string, options: CommandOptions): void {
    this.hostCommands.add(name);
    this.pi.registerCommand(name, options as never);
  }

  /** Register a Host-owned Pi event handler (operation tracking). Registered once. */
  onHostEvent(event: string, handler: Handler): void {
    if (!this.hasOn) return;
    (this.pi.on as (e: string, h: Handler) => unknown)(event, handler);
  }

  generationHandlers(generation: number, event: string): Handler[] {
    return [...(this.tables.get(generation)?.handlers.get(event) ?? [])];
  }

  generationCommand(generation: number, name: string): CommandOptions | undefined {
    return this.tables.get(generation)?.commands.get(name);
  }

  generationCommandNames(generation: number): string[] {
    return [...(this.tables.get(generation)?.commands.keys() ?? [])];
  }

  generationToolNames(generation: number): string[] {
    return [...(this.tables.get(generation)?.tools.keys() ?? [])];
  }

  generationHandlerCount(generation: number): number {
    let n = 0;
    for (const list of this.tables.get(generation)?.handlers.values() ?? []) n += list.length;
    return n;
  }

  fencedCalls(generation: number): number {
    return this.tables.get(generation)?.fencedCalls ?? 0;
  }

  /** Forget a retired generation's tables so nothing can route to it again. */
  dropGeneration(generation: number): void {
    this.tables.delete(generation);
  }

  /** Call every handler a generation registered for `event`, in order; collect failures. */
  async replay(generation: number, event: string, payload: unknown, ctx: unknown): Promise<string[]> {
    const failures: string[] = [];
    for (const handler of this.generationHandlers(generation, event)) {
      try {
        await handler(payload, ctx);
      } catch (error) {
        failures.push(`${event}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return failures;
  }

  /**
   * The ExtensionAPI a generation sees. Registrations land in the generation's
   * table and, where Pi needs one, a forwarder; actions are fenced.
   */
  createGenerationApi(generation: number, onEventBusSubscription?: (off: () => void) => void): ExtensionAPI {
    const table: GenerationTable = { handlers: new Map(), commands: new Map(), tools: new Map(), fencedCalls: 0 };
    this.tables.set(generation, table);
    const live = () => this.target.isLive(generation) && this.tables.get(generation) === table;

    const on = (event: string, handler: Handler): (() => void) => {
      if (!live()) {
        table.fencedCalls++;
        return () => {};
      }
      const list = table.handlers.get(event) ?? [];
      list.push(handler);
      table.handlers.set(event, list);
      if (!this.hostRouted.has(event)) this.ensureSlots(event, list.length);
      return () => {
        const current = table.handlers.get(event);
        const at = current?.indexOf(handler) ?? -1;
        // Splicing would shift later handlers onto earlier slots; a hole keeps
        // every other handler on its slot.
        if (current && at >= 0) current[at] = () => undefined;
      };
    };

    const registerCommand = (name: string, options: CommandOptions): void => {
      if (!live()) {
        table.fencedCalls++;
        return;
      }
      table.commands.set(name, options);
      if (this.hostCommands.has(name)) return;
      // Pi keys commands by name, so re-registering the forwarder overwrites
      // the single entry (never duplicates) and refreshes the description.
      this.commandForwarders.add(name);
      this.pi.registerCommand(name, {
        description: options.description,
        getArgumentCompletions: (prefix: string) => {
          const gen = this.target.dispatchGeneration();
          if (typeof gen !== "number") return null;
          return (this.tables.get(gen)?.commands.get(name)?.getArgumentCompletions?.(prefix) ?? null) as never;
        },
        handler: (args: string, ctx: unknown) => this.runCommand(name, args, ctx),
      } as never);
    };

    const registerTool = (tool: ToolDef): void => {
      if (!live()) {
        table.fencedCalls++;
        return;
      }
      table.tools.set(tool.name, tool);
      this.toolForwarders.add(tool.name);
      // Re-registered per generation (Pi overwrites by name), so a changed
      // schema or description reaches Pi; execution always forwards.
      this.pi.registerTool({
        ...tool,
        execute: (...args: unknown[]) => this.runTool(tool.name, args),
      } as never);
    };

    const realEvents = (this.pi as { events?: { on?: unknown; emit?: unknown } }).events;
    const events = realEvents
      ? {
          on: (channel: string, handler: (data: unknown) => void) => {
            if (!live() || typeof realEvents.on !== "function") {
              table.fencedCalls++;
              return () => {};
            }
            const off = (realEvents.on as (c: string, h: (d: unknown) => void) => () => void)(channel, (data) => {
              if (live()) handler(data);
            });
            onEventBusSubscription?.(off);
            return off;
          },
          emit: (channel: string, data: unknown) => {
            if (!live()) {
              table.fencedCalls++;
              return;
            }
            (realEvents.emit as ((c: string, d: unknown) => void) | undefined)?.(channel, data);
          },
        }
      : undefined;

    const real = this.pi as unknown as Record<string | symbol, unknown>;
    return new Proxy(real, {
      get: (target, prop) => {
        if (prop === "on") return on;
        if (prop === "registerCommand") return registerCommand;
        if (prop === "registerTool") return registerTool;
        if (prop === "events") return events;
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function" || typeof prop !== "string") return value;
        const fn = value as (...args: unknown[]) => unknown;
        if (READS.has(prop)) return fn.bind(target);
        return (...args: unknown[]) => {
          if (!live()) {
            table.fencedCalls++;
            if (PROMISE_ACTIONS.has(prop)) return Promise.reject(new StaleGenerationError(generation, prop));
            return undefined;
          }
          return fn.apply(target, args);
        };
      },
      has: (target, prop) =>
        prop === "on" ||
        prop === "registerCommand" ||
        prop === "registerTool" ||
        (prop === "events" && events !== undefined) ||
        Reflect.has(target, prop) ||
        PASSTHROUGH_REGISTRATIONS.has(String(prop)),
    }) as unknown as ExtensionAPI;
  }

  private ensureSlots(event: string, needed: number): void {
    if (!this.hasOn) return;
    let have = this.slots.get(event) ?? 0;
    while (have < needed) {
      const slot = have;
      (this.pi.on as (e: string, h: Handler) => unknown)(event, (payload: unknown, ctx: unknown) =>
        this.dispatch(event, slot, payload, ctx),
      );
      have++;
    }
    this.slots.set(event, have);
  }

  private dispatch(event: string, slot: number, payload: unknown, ctx: unknown): unknown {
    const run = (generation: number | undefined) => {
      if (generation === undefined) return undefined;
      const handler = this.tables.get(generation)?.handlers.get(event)?.[slot];
      return handler ? handler(payload, ctx) : undefined;
    };
    const target = this.target.dispatchGeneration();
    if (typeof target === "object" && target !== null) return target.then(run);
    return run(target);
  }

  private async runCommand(name: string, args: string, ctx: unknown): Promise<void> {
    await this.target.whenOpen();
    const generation = await this.target.dispatchGeneration();
    const command = generation === undefined ? undefined : this.tables.get(generation)?.commands.get(name);
    if (generation === undefined || !command) {
      notify(ctx, `/${name} is not available: no active pi-engineering runtime provides it. Try /engineering version.`);
      return;
    }
    await this.target.track(generation, "command", name, () => command.handler(args, ctx));
  }

  private async runTool(name: string, args: unknown[]): Promise<unknown> {
    await this.target.whenOpen();
    const generation = await this.target.dispatchGeneration();
    const tool = generation === undefined ? undefined : this.tables.get(generation)?.tools.get(name);
    if (generation === undefined || !tool?.execute) {
      throw new Error(`tool ${name} is not available: no active pi-engineering runtime provides it`);
    }
    const execute = tool.execute;
    return this.target.track(generation, "tool", name, async () => execute.apply(tool, args));
  }
}

function notify(ctx: unknown, text: string): void {
  try {
    (ctx as { ui?: { notify?: (t: string, l: string) => void } }).ui?.notify?.(text, "warning");
  } catch {
    // A stale ctx cannot be told anything; the command simply did nothing.
  }
}
