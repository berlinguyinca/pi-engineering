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
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { toAutocompleteItems } from "./completions.ts";
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
  /**
   * Tool names this generation claimed that Pi refused because another
   * extension already owns them (two runtime copies loaded at once). The first
   * registration wins in Pi; losing a name is not a reason to fail the load.
   */
  shadowedTools: Map<string, string>;
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
  /**
   * Run a generation's event handler as an operation, so a safe point is never
   * declared while one is still running (or about to settle).
   */
  trackEvent?(generation: number, event: string, run: () => unknown): unknown;
}

/**
 * A tool name the bridge could not serve, or a forwarded call that found nobody
 * to serve it (#672). Reported to the Host so it reaches telemetry: in the field
 * the failure was invisible after the fact, which is why it took a live session
 * to notice.
 */
export interface ToolNameEvent {
  /** `shadowed`: the name was lost at registration. `unservable`: a call found no live owner. */
  kind: "shadowed" | "unservable";
  name: string;
  generation: number | undefined;
  reason: string;
}

export interface BridgeOptions {
  /** Called for every lost or unservable tool name. Best-effort; never throws back into the bridge. */
  diagnostics?: (event: ToolNameEvent) => void;
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
  private readonly diagnostics: ((event: ToolNameEvent) => void) | undefined;
  /** (generation:name) already reported unservable, so a dead name is not logged every turn. */
  private readonly reportedUnservable = new Set<string>();

  constructor(pi: ExtensionAPI, target: BridgeTarget, hostRouted: Iterable<string> = [], options: BridgeOptions = {}) {
    this.pi = pi;
    this.target = target;
    this.hasOn = typeof (pi as { on?: unknown }).on === "function";
    this.hostRouted = new Set(hostRouted);
    this.diagnostics = options.diagnostics;
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

  /** A tool the bridge forwards (its execution is tracked after the gate). */
  isForwardedTool(name: string): boolean {
    return this.toolForwarders.has(name);
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

  /** Tool names a generation could not register because another extension owns them. */
  shadowedTools(generation: number): Array<{ name: string; reason: string }> {
    const table = this.tables.get(generation);
    return table ? [...table.shadowedTools].map(([name, reason]) => ({ name, reason })) : [];
  }

  /**
   * Every tool name any table still held lost at registration, with the
   * generation that lost it. A name lost by a generation that is still declared
   * in Pi is exactly the state #672 left behind, so the surface must not be
   * scoped to the generation currently dispatching.
   */
  toolNameLosses(): Array<{ generation: number; name: string; reason: string }> {
    const out: Array<{ generation: number; name: string; reason: string }> = [];
    for (const [generation, table] of this.tables) {
      for (const [name, reason] of table.shadowedTools) out.push({ generation, name, reason });
    }
    return out.sort((a, b) => a.generation - b.generation || a.name.localeCompare(b.name));
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
    const table: GenerationTable = {
      handlers: new Map(),
      commands: new Map(),
      tools: new Map(),
      fencedCalls: 0,
      shadowedTools: new Map(),
    };
    this.tables.set(generation, table);
    // A fresh generation ends the "no generation active" window. Drop the generation-less
    // unservable dedup keys so a later incident of the same name (e.g. after this generation
    // also retires) is reported again; numbered-generation keys are left alone, their numbers
    // only go up so a stale one is never misleading.
    for (const key of [...this.reportedUnservable]) if (key.startsWith("none:")) this.reportedUnservable.delete(key);
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
        getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
          const gen = this.target.dispatchGeneration();
          if (typeof gen !== "number") return null;
          return toAutocompleteItems(await this.tables.get(gen)?.commands.get(name)?.getArgumentCompletions?.(prefix));
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
      // Re-registered per generation (Pi overwrites by name), so a changed
      // schema or description reaches Pi; execution always forwards.
      try {
        this.pi.registerTool({
          ...tool,
          execute: (...args: unknown[]) => this.runTool(tool.name, args),
        } as never);
        this.toolForwarders.add(tool.name);
      } catch (error) {
        // Pi refuses a tool name another extension already registered (or a
        // schema it will not accept). Losing the name must not take the runtime
        // down: the copy that registered first serves it, and this one keeps
        // every other tool it owns. It is not added to toolForwarders, because
        // this generation does not own it.
        const reason = error instanceof Error ? error.message : String(error);
        table.tools.delete(tool.name);
        table.shadowedTools.set(tool.name, reason);
        this.report({ kind: "shadowed", name: tool.name, generation, reason });
      }
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
      if (!handler) return undefined;
      const track = this.target.trackEvent;
      return track ? track.call(this.target, generation, event, () => handler(payload, ctx)) : handler(payload, ctx);
    };
    const target = this.target.dispatchGeneration();
    if (typeof target === "object" && target !== null) return target.then(run);
    return run(target);
  }

  /** Run a command of the dispatch generation, gated and tracked (the forwarders and `/pie` use this). */
  async runCommand(name: string, args: string, ctx: unknown): Promise<void> {
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
    if (generation !== undefined && tool?.execute && this.target.isLive(generation)) {
      const execute = tool.execute;
      return this.target.track(generation, "tool", name, async () => execute.apply(tool, args));
    }
    // The dispatched generation does not own the name. Another live generation
    // of this bridge might — a handover that has not finished registering, or a
    // generation that lost the name at registration while its sibling kept it.
    // Serving there beats failing a declared tool the model can see.
    const holder = this.liveHolderOf(name, generation);
    const sibling = holder === undefined ? undefined : this.tables.get(holder)?.tools.get(name);
    if (holder !== undefined && sibling?.execute) {
      const execute = sibling.execute;
      return this.target.track(holder, "tool", name, async () => execute.apply(sibling, args));
    }
    const reason = this.unservableReason(name, generation);
    const key = `${generation ?? "none"}:${name}`;
    if (!this.reportedUnservable.has(key)) {
      this.reportedUnservable.add(key);
      this.report({ kind: "unservable", name, generation, reason });
    }
    throw new Error(`tool ${name} is not available: no active pi-engineering runtime provides it (${reason})`);
  }

  /** Another live generation of this bridge that owns `name`. */
  private liveHolderOf(name: string, exclude: number | undefined): number | undefined {
    for (const [generation, table] of this.tables) {
      if (generation === exclude || !this.target.isLive(generation)) continue;
      if (table.tools.get(name)?.execute) return generation;
    }
    return undefined;
  }

  /** Why a declared tool has nobody to serve it, in the caller's terms. */
  private unservableReason(name: string, generation: number | undefined): string {
    const parts: string[] = [];
    if (generation === undefined) {
      parts.push("no generation is active (a handover is in flight, or the last generation retired)");
    } else {
      const table = this.tables.get(generation);
      parts.push(
        `generation ${generation} ${this.target.isLive(generation) ? "is live" : "is retired"} and does not own "${name}"`,
      );
      const shadow = table?.shadowedTools.get(name);
      if (shadow !== undefined) parts.push(`it was lost at registration: ${shadow}`);
      else if (table === undefined) parts.push("its registration table was dropped");
      else parts.push("no live generation registered it");
    }
    parts.push("recover with /engineering reload, or restart the session");
    return parts.join("; ");
  }

  /** Tell the Host about a lost or unservable tool name; a broken listener never breaks a call. */
  private report(event: ToolNameEvent): void {
    try {
      this.diagnostics?.(event);
    } catch {
      // Diagnostics are never the reason a tool fails.
    }
  }
}

function notify(ctx: unknown, text: string): void {
  try {
    (ctx as { ui?: { notify?: (t: string, l: string) => void } }).ui?.notify?.(text, "warning");
  } catch {
    // A stale ctx cannot be told anything; the command simply did nothing.
  }
}
