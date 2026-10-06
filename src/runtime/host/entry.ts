/**
 * Pi's entry point for Pi Engineering (package.json `pi.extensions`).
 *
 * A deliberately tiny, stable shim: it imports the RuntimeHost
 * (`extension.ts`) dynamically and installs it. If the Host itself cannot be
 * imported or fails while installing, Pi would otherwise lose Pi Engineering
 * entirely; instead the shim undoes the Host's partial registrations it can
 * undo (event handlers), logs why, and loads the legacy extension
 * (`extensions/index.ts`) directly, without hot reload or self-update. The
 * `/engineering` command then reports that fallback.
 *
 * Keep this file free of imports from the rest of the package: it must load
 * even when everything else is broken.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Factory = (pi: ExtensionAPI) => unknown;

export interface EntryModules {
  host: () => Promise<{ default: Factory }>;
  legacy: () => Promise<{ default: Factory }>;
}

const DEFAULT_MODULES: EntryModules = {
  host: () => import("./extension.ts") as Promise<{ default: Factory }>,
  legacy: () => import("../../../extensions/index.ts") as Promise<{ default: Factory }>,
};

// On globalThis: Pi's loader may evaluate this module in its own module cache.
const FALLBACK = Symbol.for("pi-engineering.host-fallback.v1");

/** Why the Host is not in use, when the shim fell back (diagnostics, tests); else null. */
export function hostFallbackReason(): string | null {
  return ((globalThis as unknown as Record<symbol, string | null | undefined>)[FALLBACK] ?? null) as string | null;
}

function setFallbackReason(reason: string | null): void {
  (globalThis as unknown as Record<symbol, string | null>)[FALLBACK] = reason;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `pi` with every `on()` registration recorded, so a failed install can be undone. */
function tracking(pi: ExtensionAPI): { api: ExtensionAPI; undo: () => void } {
  const unsubscribes: Array<() => void> = [];
  const api = new Proxy(pi as unknown as Record<string | symbol, unknown>, {
    get(target, prop) {
      if (prop === "on") {
        return (event: string, handler: unknown) => {
          const off = (target.on as (e: string, h: unknown) => unknown)(event, handler);
          if (typeof off === "function") unsubscribes.push(off as () => void);
          return off;
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  }) as unknown as ExtensionAPI;
  return {
    api,
    undo: () => {
      for (const off of unsubscribes.splice(0).reverse()) {
        try {
          off();
        } catch {
          // Best effort: Pi may not support removing this handler.
        }
      }
    },
  };
}

export async function installPiEngineering(pi: ExtensionAPI, modules: EntryModules = DEFAULT_MODULES): Promise<void> {
  let stage = "import";
  const { api, undo } = tracking(pi);
  try {
    const host = await modules.host();
    stage = "initialization";
    await host.default(api);
    setFallbackReason(null);
    return;
  } catch (error) {
    undo();
    setFallbackReason(`runtime host ${stage} failed: ${describe(error)}`);
    if ((error as { generationStillRunning?: unknown } | null)?.generationStillRunning === true) {
      // The Host started a runtime it could not stop: a second (legacy) one
      // would run beside it. Stay with what runs; report the failure.
      process.stderr.write(`[pi-engineering] ${hostFallbackReason()}; its runtime is still running, no fallback\n`);
      return;
    }
  }
  const reason = hostFallbackReason() as string;
  // One line on stderr: the TUI is not up yet while extensions load.
  process.stderr.write(`[pi-engineering] ${reason}; loading the legacy extension (no hot reload or self-update)\n`);
  const legacy = await modules.legacy();
  await legacy.default(pi);
  // Overwrites a /engineering the half-installed Host may have registered.
  pi.registerCommand("engineering", {
    description: "Pi Engineering runtime host unavailable (legacy fallback)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        `Pi Engineering runtime host unavailable: ${reason}\nRunning the legacy extension: reload, update and rollback are disabled until the host loads again (restart Pi after fixing it).`,
        "warning",
      );
    },
  });
}

export default function piEngineeringEntry(pi: ExtensionAPI): Promise<void> {
  return installPiEngineering(pi);
}
