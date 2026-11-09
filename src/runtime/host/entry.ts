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

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { DiagnoseDeps } from "../../../scripts/diagnose-errors.ts";

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

/** How each D05 exit code reads in the terminal, and how many clusters one report shows. */
const DIAGNOSE_CLASS: Record<number, string> = {
  0: "ok",
  2: "usage refused",
  3: "namespace refused",
  4: "read or export failed",
};
const DIAGNOSE_TOP = 5;

/** What `/diagnose-errors` reads with. `Omit<…, "writeFile">` IS the permission scope: no writer can be injected, so
 * D05's own `--export` path fails closed (exit 4) and nothing here can write, mkdir or append. */
export interface DiagnoseHooks {
  namespace: (cwd: string) => Promise<string>;
  deps: Omit<DiagnoseDeps, "writeFile">;
}

/** The calling worktree's events namespace by this repo's existing convention — orchestration override, else state
 * root + worktree identity — and nothing else: pure path arithmetic, never a probe or mkdir, so a read-only command
 * cannot create the namespace it reports on. D04 owns recovery and this command has no durable evidence source, so a
 * row stays unresolved rather than an invented one. */
const productionDiagnoseHooks = async (): Promise<DiagnoseHooks> => {
  const [reader, aggregate, identity, stateDir, os, fs] = await Promise.all([
    import("../../incidents/errorReader.ts"),
    import("../../incidents/errorAggregate.ts"),
    import("../isolation/WorktreeIdentity.ts"),
    import("../isolation/stateDir.ts"),
    import("node:os"),
    import("node:fs"),
  ]);
  const rootFor = async (cwd: string): Promise<string> =>
    stateDir.resolveOrchestrationOverride() ??
    stateDir.worktreeRuntimeDir(stateDir.resolveStateRoot(), (await identity.resolveWorktreeIdentity(cwd)).worktreeId);
  return {
    namespace: async (cwd) => join(await rootFor(cwd), "events"),
    deps: {
      read: reader.readHostErrorOccurrences,
      aggregate: aggregate.aggregateErrorOccurrences,
      evidence: () => null,
      hostname: () => os.hostname(),
      exists: fs.existsSync,
    },
  };
};

/** The bounded report: D05's three summary lines, at most DIAGNOSE_TOP clusters, what it refused, and the exit class. */
function diagnoseReport(result: { exitCode: number; stdout: string[]; stderr: string[] }): string {
  const clusters = result.stdout.slice(3);
  const shown = [
    ...result.stdout.slice(0, 3),
    ...clusters.slice(0, DIAGNOSE_TOP),
    ...(clusters.length > DIAGNOSE_TOP
      ? [`… ${clusters.length - DIAGNOSE_TOP} more clusters (scripts/diagnose-errors.ts prints all)`]
      : []),
  ];
  return [...shown, ...result.stderr, `exit=${result.exitCode} ${DIAGNOSE_CLASS[result.exitCode] ?? "unknown"}`].join(
    "\n",
  );
}

/**
 * `/diagnose-errors` — a thin adapter over the D05 CLI, which owns every argument, read, cluster and verdict; this
 * discovers the namespace, calls `parseArgs` and `runDiagnoseErrors`, and reports what comes back. Registered by the
 * shim rather than the Host so the diagnosis exists even when the Host is broken, with D05 imported only when the
 * command runs so this file still loads on its own. Read-only by construction: `DiagnoseHooks` has no writer.
 */
export function registerDiagnoseErrors(
  pi: ExtensionAPI,
  load: () => Promise<DiagnoseHooks> = productionDiagnoseHooks,
): void {
  pi.registerCommand("diagnose-errors", {
    description:
      "Read-only diagnosis of this worktree's error namespace: clustered totals and top clusters (never writes)",
    handler: async (args, ctx) => {
      try {
        const [cli, hooks] = await Promise.all([import("../../../scripts/diagnose-errors.ts"), load()]);
        const argv = args.trim() === "" ? [] : args.trim().split(/\s+/);
        if (!argv.includes("--namespace")) argv.push("--namespace", await hooks.namespace(ctx.cwd));
        const parsed = cli.parseArgs(argv);
        if (!parsed.ok || parsed.opts === undefined) {
          ctx.ui.notify(parsed.errors.join("\n"), "warning");
          return;
        }
        const result = cli.runDiagnoseErrors(parsed.opts, hooks.deps);
        ctx.ui.notify(diagnoseReport(result), result.exitCode === 0 ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`diagnose-errors failed: ${describe(error)}`, "error");
      }
    },
  });
}

export async function installPiEngineering(pi: ExtensionAPI, modules: EntryModules = DEFAULT_MODULES): Promise<void> {
  registerDiagnoseErrors(pi); // read-only diagnosis, so it must exist whatever the Host below does
  const startedAt = Date.now();
  // The TUI renders its first frame only after extensions finish loading, so
  // for a second or more the user sees a blank terminal. stderr is the one
  // place that is visible in that window; keep it to two short lines.
  process.stderr.write(`[pi-engineering] loading runtime…\n`);
  let stage = "import";
  const { api, undo } = tracking(pi);
  try {
    const host = await modules.host();
    stage = "initialization";
    await host.default(api);
    setFallbackReason(null);
    process.stderr.write(`[pi-engineering] runtime ready in ${Date.now() - startedAt}ms\n`);
    return;
  } catch (error) {
    setFallbackReason(`runtime host ${stage} failed: ${describe(error)}`);
    if ((error as { generationStillRunning?: unknown } | null)?.generationStillRunning === true) {
      // The Host started a runtime it could not stop: a second (legacy) one
      // would run beside it. Stay with what runs, handlers (shutdown
      // included) intact; report the failure.
      process.stderr.write(`[pi-engineering] ${hostFallbackReason()}; its runtime is still running, no fallback\n`);
      return;
    }
    // Falling back: the failed Host's handlers must not run beside the legacy ones.
    undo();
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
