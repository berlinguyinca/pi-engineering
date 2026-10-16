import type { GatewayModelEntry } from "../models/gatewayCatalog.ts";
/**
 * Live-path shadow comparison for CAV model routing (MODEL-001/002/004, #274).
 *
 * The capability router in `src/cav/routing.ts` is the authority for which model
 * SHOULD serve a role, but nothing on the live path consults it today. This
 * module is the shadow mode: it runs the authoritative route against a catalogue
 * and compares it with the model a live execution actually used. It is a
 * log-only comparison — it never changes behaviour — so the runtime can emit the
 * verdict later without risking a route change.
 */
import { type CavBlocked, type CavRoute, type RouteOptions, isBlocked, routeRole } from "./routing.ts";

/** The live model a runtime actually used, as the shadow compares against it. */
export interface LiveChoice {
  provider: string;
  model: string;
}

/** Result of comparing the authoritative route against the live choice. */
export interface ShadowComparison {
  role: Parameters<typeof routeRole>[0];
  live: LiveChoice | null;
  /** The authoritative routeRole result (route or BLOCKED). */
  shadow: CavRoute | CavBlocked;
  /** Whether the live choice matches the authoritative route. */
  agrees: boolean;
  /** Human-readable explanation of the comparison. */
  reason: string;
}

function liveMatches(live: LiveChoice | null, shadow: CavRoute): boolean {
  if (!live) return false;
  return live.provider === shadow.provider && live.model === shadow.id;
}

/**
 * Compare the authoritative route for `role` against the live model a runtime
 * actually used. Shadow mode: never changes behaviour, only reports.
 *
 * - A live choice that matches the shadow route agrees.
 * - A BLOCKED shadow route never agrees; the BLOCKED reason is reported.
 * - A `null` live choice never agrees (nothing to compare).
 */
export function compareRouting(
  role: Parameters<typeof routeRole>[0],
  catalog: readonly GatewayModelEntry[],
  liveChoice: LiveChoice | null,
  opts: RouteOptions = {},
): ShadowComparison {
  const shadow = routeRole(role, catalog, opts);

  if (isBlocked(shadow)) {
    return {
      role,
      live: liveChoice,
      shadow,
      agrees: false,
      reason: `shadow route for ${role} is BLOCKED: ${shadow.reason}`,
    };
  }

  if (!liveChoice) {
    return {
      role,
      live: liveChoice,
      shadow,
      agrees: false,
      reason: `shadow route for ${role} resolved to ${shadow.provider}/${shadow.id} but no live choice was recorded`,
    };
  }

  const agrees = liveMatches(liveChoice, shadow);
  return {
    role,
    live: liveChoice,
    shadow,
    agrees,
    reason: agrees
      ? `live choice ${liveChoice.provider}/${liveChoice.model} matches the shadow route`
      : `live choice ${liveChoice.provider}/${liveChoice.model} differs from the shadow route ${shadow.provider}/${shadow.id}`,
  };
}
