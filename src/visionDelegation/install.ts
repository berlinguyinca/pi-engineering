/**
 * The Pi `input` handler that sends pasted images to a vision session when the current model is text-only.
 *
 * Evidence for the contract (docs/evidence/vision-delegation-input-spike.md): Pi awaits an async `input`
 * handler before it starts the turn, so the wait holds the turn and a second message queues behind it;
 * `ctx.signal` is undefined while the agent is idle, so it is passed through only when Pi has one.
 * Input that arrives while the agent streams (`streamingBehavior` set) is not delegated (ruling R17):
 * the image is not analyzed and the user is told so. Only the `interactive` source is handled (R16).
 */

import { type SessionHandoffMessage, sessionBranchMessages } from "../plannerWorker/sessionHandoff.ts";
import type { VisionDelegateSettings } from "./config.ts";
import type { VisionDelegator } from "./delegate.ts";
import type { VisionDelegateOutput } from "./types.ts";

/** The part of `VisionDelegator` the handler calls. */
export type VisionHandler = Pick<VisionDelegator, "handle">;

export const VISION_STATUS_KEY = "vision-delegation";

export interface PiOn {
  on(event: string, handler: (event: never, ctx: never) => unknown): void;
}

/** The slice of Pi's `input` event the handler reads. */
interface InputEvent {
  text: string;
  images?: Array<{ data: string; mimeType: string }>;
  source: string;
  streamingBehavior?: string;
}

/** The slice of Pi's extension context the handler reads. */
export interface InputContext {
  model?: { id: string; input?: readonly string[] };
  cwd: string;
  signal?: AbortSignal;
  sessionManager: {
    getSessionId(): string;
    getBranch(): Array<{ type?: string; message?: { role?: string; content?: unknown } }>;
  };
  ui: {
    setStatus(key: string, text: string | undefined): void;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

const CONTINUE = { action: "continue" } as const;
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const notAnalyzed = (why: string): string =>
  `The pasted image was not analyzed: ${why}. The current model is text-only, so it will not see the image.`;

function notify(ctx: InputContext, message: string): void {
  try {
    ctx.ui.notify(message, "warning");
  } catch {
    // A UI that cannot notify must not turn into a lost message.
  }
}

/** True when this input needs a vision model: interactive images for a model that cannot read images. */
function needsVision(event: InputEvent, ctx: InputContext): boolean {
  if (event.source !== "interactive") return false;
  if (!event.images?.length) return false;
  const model = ctx.model;
  return !!model && !(model.input ?? []).includes("image");
}

function readSignal(ctx: InputContext): AbortSignal | undefined {
  try {
    return ctx.signal ?? undefined;
  } catch {
    return undefined;
  }
}

type InputResult = VisionDelegateOutput | typeof CONTINUE;
type BuildDelegator = (ctx: InputContext) => Promise<VisionHandler | null>;

function inputHandler(build: BuildDelegator): (event: InputEvent, ctx: InputContext) => Promise<InputResult> {
  return async (event, ctx) => {
    if (!needsVision(event, ctx)) return CONTINUE;
    if (event.streamingBehavior) {
      notify(
        ctx,
        notAnalyzed("the agent is busy, and an image sent mid-turn is not delegated; send it again when idle"),
      );
      return CONTINUE;
    }
    let delegator: VisionHandler | null;
    try {
      delegator = await build(ctx);
    } catch (err) {
      notify(ctx, notAnalyzed(`vision delegation could not start (${errText(err)})`));
      return CONTINUE;
    }
    if (!delegator) {
      notify(ctx, notAnalyzed("vision delegation is unavailable"));
      return CONTINUE;
    }
    try {
      let messages: SessionHandoffMessage[];
      try {
        messages = sessionBranchMessages(ctx.sessionManager);
      } catch {
        messages = [];
      }
      return await delegator.handle({
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        text: event.text,
        images: (event.images ?? []).map((i) => ({ data: i.data, mimeType: i.mimeType })),
        messages,
        signal: readSignal(ctx),
        status: (t) => ctx.ui.setStatus(VISION_STATUS_KEY, t),
      });
    } catch (err) {
      notify(ctx, notAnalyzed(`vision delegation failed (${errText(err)})`));
      return CONTINUE;
    }
  };
}

export function registerVisionDelegation(pi: PiOn, deps: { build: BuildDelegator }): void {
  pi.on("input", inputHandler(deps.build) as never);
}

/**
 * The gate `extensions/index.ts` installs: settings are read once, lazily, on the first input that needs a
 * vision model (so a missing or malformed file costs nothing at load). With `enabled: false` the handler stays
 * inert (silent: Pi behaves as without this feature) and nothing is built. A settings note (for example a
 * malformed block) is shown once. One delegator is cached per install (one per process), so its per-session
 * queue and registry persist across calls; `current()` gives it the context of the call in flight (the model
 * and model registry can change between calls). A failed settings load or build is not cached and is retried.
 */
export function installVisionDelegation(
  pi: PiOn,
  deps: {
    loadSettings: () => Promise<VisionDelegateSettings>;
    makeDelegator: (settings: VisionDelegateSettings, current: () => InputContext) => Promise<VisionHandler>;
  },
): void {
  let settings: VisionDelegateSettings | undefined;
  let delegator: Promise<VisionHandler> | undefined;
  let latest: InputContext | undefined;
  let notesShown = false;
  const handle = inputHandler(async (ctx) => {
    latest = ctx;
    const s = settings as VisionDelegateSettings;
    delegator ??= deps
      .makeDelegator(s, () => latest as InputContext)
      .catch((err: unknown) => {
        delegator = undefined;
        throw err;
      });
    return delegator;
  });
  const gated = async (event: InputEvent, ctx: InputContext): Promise<InputResult> => {
    if (!needsVision(event, ctx)) return CONTINUE;
    try {
      settings ??= await deps.loadSettings();
    } catch (err) {
      notify(ctx, notAnalyzed(`the vision_delegate settings could not be read (${errText(err)})`));
      return CONTINUE;
    }
    if (!notesShown && settings.notes.length) {
      notesShown = true;
      for (const note of settings.notes) notify(ctx, note);
    }
    if (!settings.enabled) return CONTINUE;
    return handle(event, ctx);
  };
  pi.on("input", gated as never);
}
