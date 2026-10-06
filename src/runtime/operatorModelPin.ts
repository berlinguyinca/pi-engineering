/**
 * Operator model pin: an explicit model switch is honoured by missions.
 *
 * When the operator changes the session model (Pi `/model`, model cycling),
 * that choice becomes this session's operator pin. Missions started from (or
 * resumed in) this session adopt it at their next inference boundary — the next
 * worker dispatch, or a worker parked waiting for capacity — never mid-stream.
 * The adopted pin is persisted on the mission, so a restart keeps it, and every
 * adoption is logged as a MODEL_TRANSITION.
 *
 * The session choice is tri-state: no opinion (fresh session — a mission keeps
 * whatever it persisted), a pin, or an explicit `auto` (cleared: routing goes
 * back to role pins and the capability router).
 *
 * State lives on `globalThis`, keyed by runtime session id, so an in-process
 * reload keeps the operator's choice and another session never sees it.
 *
 * Automatic fallback switching of the INTERACTIVE model is unrelated and stays
 * off by default; a switch made by that fallback is not an operator choice.
 */

import { type ModelRef, modelKey } from "../lifecycle/types.ts";
import type { Mission, OperatorModelPin } from "../orchestration/types.ts";

export type { OperatorModelPin };

/** The session's explicit choice; absent means "no opinion". */
export type SessionModelChoice = { kind: "pin"; pin: OperatorModelPin } | { kind: "auto"; set_at: string };

interface SessionPinState {
  choice?: SessionModelChoice;
  /** The model the session started on: switching back to it clears the pin. */
  baseline?: ModelRef;
  /** Missions this session resumed explicitly (they follow its choice too). */
  claimed: Set<string>;
}

const KEY = Symbol.for("pi-engineering.operator-model-pin.v1");

function sessions(): Map<string, SessionPinState> {
  const holder = globalThis as unknown as Record<symbol, Map<string, SessionPinState> | undefined>;
  holder[KEY] ??= new Map();
  return holder[KEY]!;
}

function stateFor(sessionId: string): SessionPinState {
  const all = sessions();
  let state = all.get(sessionId);
  if (!state) {
    state = { claimed: new Set() };
    all.set(sessionId, state);
  }
  return state;
}

const sameModel = (a: ModelRef | null | undefined, b: ModelRef | null | undefined): boolean =>
  !!a && !!b && modelKey(a) === modelKey(b);

export function sessionModelChoice(sessionId: string): SessionModelChoice | undefined {
  return sessions().get(sessionId)?.choice;
}

/** Pin `model` for this session's missions. */
export function setOperatorModelPin(sessionId: string, model: ModelRef, now: Date = new Date()): SessionModelChoice {
  const choice: SessionModelChoice = {
    kind: "pin",
    pin: { provider: model.provider, id: model.id, set_at: now.toISOString() },
  };
  stateFor(sessionId).choice = choice;
  return choice;
}

/** Explicitly return this session's missions to automatic routing. */
export function clearOperatorModelPin(sessionId: string, now: Date = new Date()): SessionModelChoice {
  const choice: SessionModelChoice = { kind: "auto", set_at: now.toISOString() };
  stateFor(sessionId).choice = choice;
  return choice;
}

/**
 * A new Pi session starts with no opinion. `model` is what it starts on; a
 * later switch back to it clears the pin.
 */
export function resetSessionModelChoice(sessionId: string, model?: ModelRef): void {
  sessions().set(sessionId, { claimed: new Set(), ...(model ? { baseline: { ...model } } : {}) });
}

/** A mission resumed by this session follows its model choice from now on. */
export function claimMissionForSession(sessionId: string, missionId: string): void {
  stateFor(sessionId).claimed.add(missionId);
}

export type ModelSelectOutcome =
  | { action: "pinned"; pin: OperatorModelPin }
  | { action: "cleared"; reason: string }
  | { action: "ignored"; reason: string };

/**
 * Interpret a Pi `model_select`. Only an operator's switch ("set"/"cycle")
 * counts; restoring a saved session or our own automatic fallback does not.
 * Switching back to the model the session started on clears the pin.
 */
export function onOperatorModelSelect(
  sessionId: string,
  event: { model?: ModelRef; source?: string; automatic?: boolean },
  now: Date = new Date(),
): ModelSelectOutcome {
  if (!event.model) return { action: "ignored", reason: "no model" };
  if (event.automatic) return { action: "ignored", reason: "automatic fallback switch" };
  if (event.source !== "set" && event.source !== "cycle") {
    return { action: "ignored", reason: `source ${event.source ?? "unknown"}` };
  }
  const state = stateFor(sessionId);
  if (state.choice?.kind === "pin" && sameModel(state.baseline, event.model)) {
    clearOperatorModelPin(sessionId, now);
    return { action: "cleared", reason: `switched back to ${modelKey(event.model)}` };
  }
  const choice = setOperatorModelPin(sessionId, event.model, now);
  return { action: "pinned", pin: (choice as { kind: "pin"; pin: OperatorModelPin }).pin };
}

/** "model: gw/x (operator pin)" or "model: auto (role pins / capability router)". */
export function describeModelChoice(choice: SessionModelChoice | undefined): string {
  if (choice?.kind === "pin") return `model: ${modelKey(choice.pin)} (operator pin)`;
  if (choice?.kind === "auto") return "model: auto (role pins / capability router; operator pin cleared)";
  return "model: auto (role pins / capability router)";
}

/** Status line for one mission's persisted pin. */
export function describeMissionModel(mission: Pick<Mission, "operator_model_pin">): string | null {
  const pin = mission.operator_model_pin;
  return pin ? `model: ${modelKey(pin)} (operator pin)` : null;
}

export interface PinTransition {
  missionId: string;
  from: string | null;
  to: string | null;
  reason: string;
}

/**
 * The operator pin a mission dispatches with right now.
 *
 * At this inference boundary a mission started from (or resumed in) this
 * session adopts the session's choice: a pin is persisted on the mission, an
 * explicit `auto` removes it, and either is reported as a transition. Any other
 * mission — another session's, or this one after a restart before the operator
 * chose anything — keeps what it persisted.
 */
export function adoptOperatorModelPin(opts: {
  store: {
    getMission(id: string): Mission | undefined;
    updateMission(id: string, patch: { operator_model_pin: OperatorModelPin | null }): unknown;
  };
  missionId: string;
  sessionId: string;
  onTransition?: (transition: PinTransition) => void;
}): OperatorModelPin | null {
  const mission = opts.store.getMission(opts.missionId);
  if (!mission) return null;
  const current = mission.operator_model_pin ?? null;
  if (["COMPLETE", "FAILED", "CANCELED"].includes(mission.status)) return current;
  const state = sessions().get(opts.sessionId);
  const ours = mission.parent_session_id === opts.sessionId || !!state?.claimed.has(opts.missionId);
  const choice = state?.choice;
  if (!ours || !choice) return current;
  const desired = choice.kind === "pin" ? choice.pin : null;
  if (sameModel(current, desired) || (!current && !desired)) return current;
  opts.store.updateMission(opts.missionId, { operator_model_pin: desired ? { ...desired } : null });
  try {
    opts.onTransition?.({
      missionId: opts.missionId,
      from: current ? modelKey(current) : null,
      to: desired ? modelKey(desired) : null,
      reason: desired ? "operator pin" : "operator pin cleared",
    });
  } catch {
    // Observers never break dispatch.
  }
  return desired;
}
