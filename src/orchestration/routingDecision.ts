/**
 * Durable record of a worker model-routing decision that relied on, or left,
 * the mission's pin. Transient worker activity ("operator pin X cannot serve
 * implementer") is not persisted, so without this the Mission log cannot say
 * why a worker ran on another model. One record per task+role is kept as the
 * latest decision; a change is one `task.routing_decided` event.
 */

export type RoutingReason =
  | "pin_honoured"
  | "pin_refused"
  | "pin_excluded_held"
  | "pin_excluded_rerouted"
  | "takeover_after_failure"
  | "reviewer_separation";

export const ROUTING_REASONS: ReadonlySet<string> = new Set<RoutingReason>([
  "pin_honoured",
  "pin_refused",
  "pin_excluded_held",
  "pin_excluded_rerouted",
  "takeover_after_failure",
  "reviewer_separation",
]);

/** Free text (a router refusal, an error class) is cut to this many characters. */
export const ROUTING_TEXT_LIMIT = 200;

export interface RoutingDecision {
  missionId: string;
  taskId: string;
  role: string;
  /** "provider/id" the mission was pinned to, or null. */
  pin: string | null;
  /** "provider/id" the worker was placed on; null when routing named no model. */
  chosen: string | null;
  reason: RoutingReason;
  /** The router's refusal text (pin_refused), truncated. */
  refusal?: string;
  /** takeover_after_failure: the model that failed, the one taken over to, and the error class. */
  from?: string;
  to?: string;
  errorClass?: string;
  /** When the decision was recorded (ISO); set by the store. */
  at?: string;
}

export function clipRoutingText(text: string): string {
  return text.length > ROUTING_TEXT_LIMIT ? `${text.slice(0, ROUTING_TEXT_LIMIT - 1)}…` : text;
}

/** Canonical form: bounded text, optional fields only when present. */
export function normalizeRoutingDecision(d: RoutingDecision): RoutingDecision {
  return {
    missionId: d.missionId,
    taskId: d.taskId,
    role: clipRoutingText(d.role),
    pin: d.pin,
    chosen: d.chosen,
    reason: d.reason,
    ...(d.refusal ? { refusal: clipRoutingText(d.refusal) } : {}),
    ...(d.from ? { from: d.from } : {}),
    ...(d.to ? { to: d.to } : {}),
    ...(d.errorClass ? { errorClass: clipRoutingText(d.errorClass) } : {}),
  };
}

/** Same decision, ignoring when it was recorded. */
export function sameRoutingDecision(a: RoutingDecision, b: RoutingDecision): boolean {
  return (
    a.pin === b.pin &&
    a.chosen === b.chosen &&
    a.reason === b.reason &&
    (a.refusal ?? "") === (b.refusal ?? "") &&
    (a.from ?? "") === (b.from ?? "") &&
    (a.to ?? "") === (b.to ?? "") &&
    (a.errorClass ?? "") === (b.errorClass ?? "")
  );
}

/** One short operator sentence for a recorded decision. */
export function describeRoutingDecision(d: RoutingDecision): string {
  const pin = d.pin ?? "none";
  switch (d.reason) {
    case "pin_honoured":
      return `pin ${pin} honoured for ${d.role}`;
    case "pin_refused":
      return `pin ${pin} refused for ${d.role}${d.refusal ? ` (${d.refusal})` : ""}; routed to ${d.chosen ?? "the default model"}`;
    case "pin_excluded_held":
      return `pin ${pin} was tried or unavailable; the mission is held on it (hold_mission_model)`;
    case "pin_excluded_rerouted":
      return `pin ${pin} was tried or unavailable; ${d.role} was rerouted to ${d.chosen ?? "the default model"}`;
    case "reviewer_separation":
      return `${d.role} runs on ${d.chosen ?? "another model"}, not pin ${pin}, to stay independent of the work it reviews`;
    case "takeover_after_failure":
      return `${d.role} moved from ${d.from ?? "?"} to ${d.to ?? "?"} after ${d.errorClass ?? "a model failure"}`;
  }
}
