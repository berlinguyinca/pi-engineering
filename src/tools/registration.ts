/**
 * Collision-tolerant tool registration.
 *
 * Tool names are global in Pi, and two copies of this runtime declare the same
 * ones — the installed package plus a worktree checkout, which is the ordinary
 * development setup.
 *
 * Scope, verified against pi 1.4.0: Pi checks name uniqueness *after* an
 * extension finishes loading. `registerTool()` returns normally and the load
 * fails afterwards with `Tool "ledger_read" conflicts with <other path>`, so no
 * try/catch inside an extension can prevent that. See docs/usage.md, "Loading
 * one runtime per session".
 *
 * What this does handle is a host that rejects a name synchronously — the case
 * the runtime can act on, which src/runtime/host/piBridge.ts hits when a new
 * generation registers mid-session. The rule there: the first registration
 * wins, a lost name is reported rather than thrown, and the rest of the surface
 * still registers.
 */

/** The slice of the Pi extension API this helper needs. */
export interface ToolRegistrar {
  registerTool(tool: { name: string }): void;
  /** Optional: when present, collisions are detected before they throw. */
  getAllTools?(): Array<{ name: string }>;
}

export interface RegistrationOutcome {
  registered: string[];
  skipped: Array<{ name: string; reason: string }>;
}

/**
 * Register `tools`, skipping any name already taken or rejected by the host.
 * Never throws: a host that refuses a tool is reported, not propagated, because
 * propagating it would take every other tool in the batch down with it.
 */
export function registerToolsTolerant(host: ToolRegistrar, tools: Array<{ name: string }>): RegistrationOutcome {
  const taken = new Set<string>();
  // Pi forbids action methods while extensions are still loading, so the
  // pre-flight view is best-effort. When it is unavailable the try/catch below
  // still catches a host that rejects a name synchronously.
  try {
    for (const tool of host.getAllTools?.() ?? []) taken.add(tool.name);
  } catch {
    // No visibility yet; registration will report conflicts instead.
  }

  const registered: string[] = [];
  const skipped: RegistrationOutcome["skipped"] = [];

  for (const tool of tools) {
    if (taken.has(tool.name)) {
      skipped.push({ name: tool.name, reason: "already registered by another extension" });
      continue;
    }
    try {
      host.registerTool(tool);
      taken.add(tool.name);
      registered.push(tool.name);
    } catch (error) {
      skipped.push({ name: tool.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { registered, skipped };
}

/** One operator-facing line about what was skipped, or null when nothing was. */
export function describeSkippedTools(skipped: RegistrationOutcome["skipped"]): string | null {
  if (skipped.length === 0) return null;
  const names = skipped.map((entry) => entry.name).join(", ");
  const plural = skipped.length === 1 ? "" : "s";
  return `pi-engineering: ${skipped.length} tool${plural} already registered by another extension, kept the existing ones (${names}). If the other extension is a second copy of this runtime, load one per session: remove the other extension, or run \`pi --no-extensions --extension <path>/extensions/index.ts\`.`;
}
