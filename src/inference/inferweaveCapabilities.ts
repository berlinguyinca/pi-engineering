/**
 * Pi capability names -> the InferWeave capability vocabulary (autospec R-MODEL).
 *
 * Pi names its needs one way (`tool_calling`, `long_context`, role names such as
 * `implementer`); the gateway matches another (`tool_use`, `coding.*`, namespaced
 * ids such as `llm.code`). A name the gateway does not understand is a hard
 * constraint it cannot satisfy, so a REQUIRED capability is never sent
 * untranslated and never silently dropped: it maps, passes through as
 * gateway-native, or throws. Only PREFERENCES may be dropped, and a drop is
 * logged.
 *
 * `long_context` is not a capability on the wire. It travels as a minimum
 * context window through `x-inferweave-min-context`.
 */

/** The 128K class: the same boundary `modelRecord.ts` uses to tag a model long_context. */
export const LONG_CONTEXT_MIN_TOKENS = 128_000;

/**
 * Pi name -> gateway name. The coding roles mirror `DEFAULT_ROLE_CONFIG` in
 * `plannerWorker/roles.ts` (a test keeps the two in step).
 */
export const CAPABILITY_MAP: Readonly<Record<string, string>> = {
  tool_calling: "tool_use",
  planner: "coding.planning",
  researcher: "coding.analysis",
  implementer: "coding.implementation",
  reviewer: "coding.review",
  debugger: "coding.debugging",
  fixer: "coding.implementation",
  escalation: "coding.escalation",
};

/** Namespaced ids (`coding.review`, `llm.tool_use`) belong to the gateway's own vocabulary. */
const NAMESPACED = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
/** Bare names the gateway itself advertises: every value Pi names are mapped onto. */
const BARE_NATIVE: ReadonlySet<string> = new Set(Object.values(CAPABILITY_MAP).filter((v) => !v.includes(".")));

export function isGatewayNative(name: string): boolean {
  return NAMESPACED.test(name) || BARE_NATIVE.has(name);
}

export interface GatewayCapabilities {
  /** Hard constraints, in gateway vocabulary, de-duplicated, order preserved. */
  required: string[];
  /** Soft preferences that translated. */
  preferred: string[];
  /** Preferences with no gateway name; not sent. */
  dropped: string[];
  /** Set when `long_context` was required: send as the minimum context window. */
  minContextTokens?: number;
}

export interface ToGatewayOptions {
  /** Receives the one-line notice for dropped preferences (default console.warn). */
  warn?: (message: string) => void;
}

function translate(name: string): string | undefined {
  const mapped = CAPABILITY_MAP[name];
  if (mapped !== undefined) return mapped;
  return isGatewayNative(name) ? name : undefined;
}

const unique = (names: string[]): string[] => [...new Set(names)];

export function toGatewayCapabilities(
  required: readonly string[],
  preferred: readonly string[],
  options: ToGatewayOptions = {},
): GatewayCapabilities {
  const out: string[] = [];
  let minContextTokens: number | undefined;
  for (const name of required) {
    if (name === "long_context") {
      minContextTokens = LONG_CONTEXT_MIN_TOKENS;
      continue;
    }
    const mapped = translate(name);
    if (mapped === undefined) {
      throw new Error(
        `required capability "${name}" has no InferWeave mapping and is not gateway-native; refusing to send it untranslated`,
      );
    }
    out.push(mapped);
  }
  const soft: string[] = [];
  const dropped: string[] = [];
  for (const name of preferred) {
    const mapped = name === "long_context" ? undefined : translate(name);
    if (mapped === undefined) dropped.push(name);
    else soft.push(mapped);
  }
  if (dropped.length > 0) {
    (options.warn ?? ((m: string) => console.warn(m)))(
      `inferweave capabilities: dropped unmapped preferences: ${dropped.join(", ")}`,
    );
  }
  return {
    required: unique(out),
    preferred: unique(soft),
    dropped,
    ...(minContextTokens !== undefined ? { minContextTokens } : {}),
  };
}
