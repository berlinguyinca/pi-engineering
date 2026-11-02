/**
 * Vision delegation: hand pasted images to a vision model in a herdr pane,
 * wait for its result file, and return the analysis as text. The first image
 * of a session starts a new pane; later ones prompt the same registered agent
 * by its unique name (after `getAgent(name)` confirms it still answers from the
 * registered pane id, R22) with file paths only. Calls for one
 * session queue behind each other; a reused session that fails is dropped.
 *
 * Every outcome other than "no images" becomes explicit text; nothing throws
 * out of `handle`, and every failure names the saved image paths so the
 * picture stays reachable. Each request owns `<artifactDir>/<requestId>/` and
 * only ever reads its own result path. A result that lands after a timeout or
 * cancel is left unread; `state.json` records that it was never injected.
 */

import { join } from "node:path";

import type { HerdrAgent } from "../runtime/herdr/HerdrCli.ts";
import { awaitResult } from "./awaitResult.ts";
import { chooseVisionModel } from "./chooseModel.ts";
import { saveImages } from "./images.ts";
import { type SavedImage, type VisionRequest, renderHandback, resultPath } from "./protocol.ts";
import type { RegistryEntry } from "./registry.ts";
import { type RequestStateRecord, writeRequestFiles, writeState } from "./requestFiles.ts";
import { SessionQueue } from "./sessionQueue.ts";
import type {
  LineageEvent,
  LineageOutcome,
  VisionDelegateInput,
  VisionDelegateOutput,
  VisionDelegatorDeps,
} from "./types.ts";

import { promptReusedPane, startNewPane, visionAgentName } from "./visionPane.ts";

export type * from "./types.ts";
export { visionAgentName } from "./visionPane.ts";

type Model = { provider: string; id: string };

/** One request on its way to a vision pane; `paneId` is set once a pane exists. */
interface Delegation {
  input: VisionDelegateInput;
  request: VisionRequest;
  reqDir: string;
  model: Model;
  agentName: string;
  sessionDir: string;
  /** Prompting a registered pane rather than a new one. */
  reused: boolean;
  /** A stale entry was dropped first: earlier images are not in this session's context. */
  restarted: boolean;
  paneId?: string;
}

const RESTART_NOTE =
  "Note: the earlier vision session had closed, so a new one was started. Earlier images from this conversation are no longer in the vision session's context.";

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class VisionDelegator {
  private readonly deps: VisionDelegatorDeps;
  /** Each session's queue; idle sessions are dropped. */
  private readonly chains = new SessionQueue();

  constructor(deps: VisionDelegatorDeps) {
    this.deps = deps;
  }

  /** Calls for one session run strictly one after another, in call order; sessions run independently. */
  async handle(input: VisionDelegateInput): Promise<VisionDelegateOutput> {
    if (input.images.length === 0) return { action: "continue" };
    const queued = this.chains.has(input.sessionId);
    if (queued) safeStatus(input, "waiting for earlier image…");
    return this.chains.run(input.sessionId, async () => {
      if (queued) safeStatus(input, undefined);
      try {
        return await this.handleOne(input);
      } catch (err) {
        return this.failure({ ...input, text: "" }, [], `vision delegation failed unexpectedly (${errText(err)})`);
      }
    });
  }

  /** Routing: reuse a live registered pane, else start a new one. */
  private async handleOne(input: VisionDelegateInput): Promise<VisionDelegateOutput> {
    let requestId: string;
    let reqDir: string;
    try {
      requestId = this.deps.newId();
      reqDir = join(this.deps.artifactDir, requestId);
      resultPath(reqDir, requestId); // rejects unsafe ids before anything is written
    } catch (err) {
      return this.failure(input, [], `could not create a request id (${errText(err)})`);
    }

    let images: SavedImage[];
    try {
      images = await saveImages(input.images, reqDir);
    } catch (err) {
      return this.failure(input, [], `the image(s) could not be saved (${errText(err)})`);
    }
    if (input.signal?.aborted) {
      return this.failure(input, images, "the delegation was cancelled before the vision model answered");
    }
    const newRequest = (): VisionRequest => ({
      requestId,
      sessionId: input.sessionId,
      userText: input.text,
      images,
      createdAt: new Date(this.deps.now()).toISOString(),
    });

    const { herdr, originPaneId, registry } = this.deps;
    let restarted = false;
    let entry: RegistryEntry | undefined;
    try {
      entry = registry.get(input.sessionId);
    } catch {
      entry = undefined; // an unreadable registry only costs reuse
    }
    if (entry) {
      // R22: ask by the unique agent name and require it to answer from the registered pane. Anything
      // else (unknown name, a different pane) is a stale entry: never prompt it, never close it.
      let agent: HerdrAgent | null;
      try {
        agent = await herdr.getAgent(entry.agentName);
      } catch (err) {
        // Not proof the session is gone: keep the entry, start nothing, fail this one explicitly.
        const why = `the open vision session is unavailable (herdr could not check vision agent ${entry.agentName}: ${errText(err)})`;
        return this.failure(input, images, why);
      }
      if (agent !== null && agent.pane_id === entry.paneId) {
        const { paneId, agentName, sessionDir } = entry;
        const model = entry.model ?? { provider: "unknown", id: "the open vision session" };
        const request = newRequest();
        const d: Delegation = { input, request, reqDir, model, agentName, sessionDir, reused: true, restarted, paneId };
        return this.delegate(d, () => promptReusedPane(herdr, agentName, paneId, reqDir, request));
      }
      this.forget(input.sessionId);
      restarted = true;
    }
    const failure = (why: string) => this.failure(input, images, why, restarted);

    if (!herdr.splitPane || !originPaneId) {
      const why = !herdr.splitPane
        ? "this herdr client cannot split panes"
        : "this session is not running in a herdr pane";
      return failure(`herdr is unavailable (${why})`);
    }
    const split = herdr.splitPane.bind(herdr);

    let model: Model;
    try {
      const chosen = await chooseVisionModel({
        models: this.deps.models,
        preference: this.deps.settings.aliasPreference,
        probeFor: this.deps.probeFor,
      });
      if ("none" in chosen) return failure(`no vision model was available.\n${chosen.reason}`);
      model = { provider: chosen.provider, id: chosen.id };
    } catch (err) {
      return failure(`no vision model was available (${errText(err)})`);
    }
    const d: Delegation = {
      input,
      request: newRequest(),
      reqDir,
      model,
      agentName: visionAgentName(input.sessionId, requestId),
      sessionDir: join(reqDir, "session"),
      reused: false,
      restarted,
    };
    return this.delegate(d, () =>
      startNewPane(herdr, split, { ...d, originPaneId, cwd: input.cwd, images: d.request.images }, async (paneId) => {
        d.paneId = paneId;
        await this.state(d, { status: "waiting" });
      }),
    );
  }

  /** Writes the request files, delivers, waits, and hands back. */
  private async delegate(d: Delegation, deliver: () => Promise<string>): Promise<VisionDelegateOutput> {
    const { input, request, reqDir, model, reused, restarted } = d;
    const { herdr } = this.deps;
    const images = request.images;
    const lineage = (phase: "out" | "back", outcome: LineageOutcome) =>
      this.emit({
        phase,
        requestId: request.requestId,
        fromSession: input.sessionId,
        toSession: d.agentName,
        fromModel: this.deps.textModel,
        toModel: `${model.provider}/${model.id}`,
        outcome,
      });
    // Every non-ok outcome: record state first, then close the pane best effort. `d.paneId` is only ever a
    // pane this call created or whose identity it confirmed (R22); a stale entry's pane never reaches here.
    // A reused session that failed is no longer trusted: drop it so the next image starts clean.
    const fail = async (
      status: RequestStateRecord["status"],
      outcome: LineageOutcome,
      why: string,
      reason?: string,
    ): Promise<VisionDelegateOutput> => {
      lineage("back", outcome);
      await this.state(d, { status, reason });
      if (reused) this.forget(input.sessionId);
      if (d.paneId !== undefined) {
        try {
          await herdr.closePane(d.paneId);
        } catch {
          // Best effort: a pane that will not close never changes the answer.
        }
      }
      return this.failure(input, images, why, restarted);
    };

    let paneId: string;
    try {
      await writeRequestFiles(reqDir, request, input);
      await this.state(d, { status: "waiting" });
      lineage("out", "ok");
      paneId = await deliver();
    } catch (err) {
      const step = reused ? "prompting the open vision session" : "starting the vision pane";
      return fail("failed", "failed", `${step} failed (${errText(err)})`, errText(err));
    }

    const outcome = await awaitResult({
      file: resultPath(reqDir, request.requestId),
      request,
      paneGone: async () => {
        try {
          const agent = await herdr.getAgent(d.agentName);
          return agent === null || agent.pane_id !== paneId;
        } catch {
          return false; // transient herdr error: not proof the pane is gone
        }
      },
      waitSeconds: this.deps.settings.waitSeconds,
      now: () => this.deps.now(),
      sleep: (ms) => this.deps.sleep(ms),
      signal: input.signal,
      status: (t) => safeStatus(input, t),
    });

    if (outcome.kind === "result") {
      const { result } = outcome;
      lineage("back", result.status);
      await this.state(d, { status: "done", resultStatus: result.status });
      if (!reused) {
        try {
          const { agentName, sessionDir } = d;
          this.deps.registry.set(input.sessionId, {
            paneId,
            agentName,
            sessionDir,
            startedAt: request.createdAt,
            model,
          });
        } catch {
          // Registry failure only costs reuse later; the analysis is still delivered.
        }
      }
      const handback = renderHandback(input.text, result, model.id, images);
      return { action: "transform", text: restarted ? `${handback}\n\n${RESTART_NOTE}` : handback, images: [] };
    }
    if (outcome.kind === "timeout") {
      const secs = this.deps.settings.waitSeconds;
      return fail("timed_out", "timeout", `the analysis timed out after ${secs} seconds (vision model ${model.id})`);
    }
    if (outcome.kind === "cancelled") {
      return fail("cancelled", "failed", "the delegation was cancelled before the vision model answered");
    }
    if (outcome.kind === "pane_dead") {
      const why = "the vision pane exited before writing a result";
      return fail("failed", "failed", why, why);
    }
    const why = `the vision result was rejected and the delegation failed (${outcome.reason})`;
    return fail("failed", "failed", why, outcome.reason);
  }

  private state(d: Delegation, s: Omit<RequestStateRecord, "requestId" | "paneId">): Promise<void> {
    return writeState(d.reqDir, { requestId: d.request.requestId, paneId: d.paneId, ...s }, this.deps.now());
  }

  private forget(sessionId: string): void {
    try {
      this.deps.registry.remove(sessionId);
    } catch {
      // A locked registry only risks one more stale check later (getAgent catches it).
    }
  }

  private emit(e: LineageEvent): void {
    try {
      this.deps.lineage?.(e);
    } catch {
      // A broken lineage sink must never break the delegation.
    }
  }

  private failure(
    input: VisionDelegateInput,
    images: SavedImage[],
    why: string,
    restarted = false,
  ): VisionDelegateOutput {
    const n = input.images.length;
    const ask = input.text.trim();
    const lines = [
      ask
        ? `The user attached ${n} image(s) with this message: ${ask}`
        : `The user attached ${n} image(s) with no accompanying text.`,
      "You cannot see the image(s), and no vision analysis is available.",
      `Vision delegation did not complete: ${why}`,
    ];
    if (images.length > 0) {
      lines.push(
        "The image(s) are saved here; tell the user, who can paste them again or open them:",
        ...images.map((i) => `- ${i.path} (${i.mimeType})`),
      );
    } else {
      lines.push("The image(s) could not be saved to disk; ask the user to paste them again.");
    }
    if (restarted) lines.push(RESTART_NOTE);
    return { action: "transform", text: lines.join("\n"), images: [] };
  }
}

function safeStatus(input: VisionDelegateInput, text: string | undefined): void {
  try {
    input.status?.(text);
  } catch {
    // A broken status line must never break the delegation.
  }
}
