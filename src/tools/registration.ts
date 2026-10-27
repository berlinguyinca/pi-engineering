/**
 * Collision-tolerant tool registration.
 *
 * Tool names are global in Pi. Registering a name another extension already
 * owns throws, and a thrown registration fails the whole extension load. That
 * is correct for a real conflict, and fatal for the ordinary development case:
 * the installed `pi-engineering` package plus a worktree checkout of the same
 * runtime both declare `ledger_read`, `mission`, and friends, so the second
 * checkout used to refuse to load at all — with an error that named the OTHER
 * extension and looked like a broken install.
 *
 * The rule here: the first registration wins, the rest are skipped and reported.
 * A runtime is identified by what it does, not by which copy of the file
 * registered the tool first.
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
  // still catches a real collision — the view only makes the reason clearer.
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
  return `pi-engineering: ${skipped.length} tool${plural} already registered by another runtime copy, kept the existing ones (${names}). Load one runtime per session: remove the other extension, or run \`pi --no-extensions --extension <path>/extensions/index.ts\`.`;
}
