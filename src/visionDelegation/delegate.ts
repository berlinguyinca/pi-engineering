/**
 * Vision delegation: hand pasted images to a vision model in a herdr pane,
 * wait for its result file, and return the analysis as text. The first image
 * of a session starts a new pane; later ones prompt the same registered pane
 * (after `getAgent` confirms it is alive) with file paths only. Calls for one
 * session queue behind each other; a reused session that fails is dropped.
 *
 * Every outcome other than "no images" becomes explicit text; nothing throws
 * out of `handle`, and every failure names the saved image paths so the
 * picture stays reachable. Each request owns `<artifactDir>/<requestId>/` and
 * only ever reads its own result path. A result that lands after a timeout or
 * cancel is left unread; `state.json` records that it was never injected.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { type SessionHandoffMessage, buildSessionHandoff } from "../plannerWorker/sessionHandoff.ts";
import type { ProbeResult } from "../resilience/probe.ts";
import type { HerdrAgent, HerdrCli } from "../runtime/herdr/HerdrCli.ts";
import { chooseVisionModel } from "./chooseModel.ts";
import type { VisionDelegateSettings } from "./config.ts";
import { saveImages } from "./images.ts";
import {
  type SavedImage,
  type VisionRequest,
  type VisionResult,
  buildRequestFile,
  parseResult,
  renderHandback,
  resultPath,
} from "./protocol.ts";
import type { RegistryEntry, VisionRegistry } from "./registry.ts";
import { VISION_ROLE_PROMPT } from "./rolePrompt.ts";

export type LineageOutcome = "ok" | "partial" | "failed" | "timeout";

export interface LineageEvent {
  phase: "out" | "back";
  requestId: string;
  fromSession: string;
  toSession: string | null;
  fromModel: string;
  toModel: string;
  outcome: LineageOutcome;
}

export interface VisionDelegatorDeps {
  herdr: HerdrCli;
  settings: VisionDelegateSettings;
  models: Array<{ provider: string; id: string; input?: string[] }>;
  probeFor: (m: { provider: string; id: string }) => Promise<ProbeResult>;
  registry: VisionRegistry;
  artifactDir: string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
  lineage?: (e: LineageEvent) => void;
  /** Id of the current text model (lineage `fromModel`). */
  textModel: string;
  /** Pane the vision pane splits from (the caller's HERDR_PANE_ID). Absent means herdr is unavailable. */
  originPaneId?: string;
}

export interface VisionDelegateInput {
  sessionId: string;
  cwd: string;
  text: string;
  images: Array<{ data: string; mimeType: string }>;
  messages: SessionHandoffMessage[];
  signal?: AbortSignal;
  status?: (text: string | undefined) => void;
}

export type VisionDelegateOutput = { action: "continue" } | { action: "transform"; text: string; images: [] };

type RequestState = "waiting" | "done" | "failed" | "timed_out" | "cancelled";

type WaitOutcome =
  | { kind: "result"; result: VisionResult }
  | { kind: "invalid"; reason: string }
  | { kind: "timeout" }
  | { kind: "cancelled" }
  | { kind: "pane_dead" };

const POLL_MS = 500;
/** `agent prompt` only submits (the result file is the completion signal), so this is short. */
const PROMPT_TIMEOUT_MS = 30_000;
const RESTART_NOTE =
  "Note: the earlier vision session had closed, so a new one was started. Earlier images from this conversation are no longer in the vision session's context.";
/** Every Nth poll asks herdr whether the vision pane still exists. */
const PANE_CHECK_EVERY = 5;

/** `vision-<session8>-<request8>`, lowercased, [a-z0-9-] only, at most 32 chars (R9). */
export function visionAgentName(sessionId: string, requestId: string): string {
  return `vision-${sessionId.slice(0, 8)}-${requestId.slice(0, 8)}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 32);
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class VisionDelegator {
  private readonly deps: VisionDelegatorDeps;
  /** Tail of each session's queue; dropped once that session is idle. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(deps: VisionDelegatorDeps) {
    this.deps = deps;
  }

  /** Calls for one session run strictly one after another, in call order; sessions run independently. */
  async handle(input: VisionDelegateInput): Promise<VisionDelegateOutput> {
    if (input.images.length === 0) return { action: "continue" };
    const { sessionId } = input;
    const prev = this.chains.get(sessionId);
    if (prev) safeStatus(input, "waiting for earlier image…");
    const run = (prev ?? Promise.resolve()).then(async () => {
      if (prev) safeStatus(input, undefined);
      try {
        return await this.handleOne(input);
      } catch (err) {
        return this.failure({ ...input, text: "" }, [], `vision delegation failed unexpectedly (${errText(err)})`);
      }
    });
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(sessionId, tail);
    try {
      return await run;
    } finally {
      if (this.chains.get(sessionId) === tail) this.chains.delete(sessionId);
    }
  }

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

    const { herdr, originPaneId, registry } = this.deps;
    let restarted = false;
    let entry: RegistryEntry | undefined;
    try {
      entry = registry.get(input.sessionId);
    } catch {
      entry = undefined; // an unreadable registry only costs reuse
    }
    if (entry) {
      let agent: HerdrAgent | null;
      try {
        agent = await herdr.getAgent(entry.paneId);
      } catch (err) {
        // Not proof the pane is gone: keep the entry, start nothing, fail this one explicitly.
        const why = `the open vision session is unavailable (herdr could not check pane ${entry.paneId}: ${errText(err)})`;
        return this.failure(input, images, why);
      }
      if (agent !== null) {
        const model = entry.model ?? { provider: "unknown", id: "the open vision session" };
        return this.delegate(input, requestId, reqDir, images, model, { reuse: entry });
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

    let model: { provider: string; id: string };
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
    return this.delegate(input, requestId, reqDir, images, model, { originPaneId, restarted });
  }

  /** Delivers one request (new pane, or a prompt to the reused one), waits, and hands back. */
  private async delegate(
    input: VisionDelegateInput,
    requestId: string,
    reqDir: string,
    images: SavedImage[],
    model: { provider: string; id: string },
    via: { reuse: RegistryEntry } | { originPaneId: string; restarted: boolean },
  ): Promise<VisionDelegateOutput> {
    const { herdr } = this.deps;
    const reuse = "reuse" in via ? via.reuse : undefined;
    const restarted = "restarted" in via && via.restarted;
    const agentName = reuse?.agentName ?? visionAgentName(input.sessionId, requestId);
    const sessionDir = reuse?.sessionDir ?? join(reqDir, "session");
    const request: VisionRequest = {
      requestId,
      sessionId: input.sessionId,
      userText: input.text,
      images,
      createdAt: new Date(this.deps.now()).toISOString(),
    };
    const lineage = (phase: "out" | "back", outcome: LineageOutcome) =>
      this.emit({
        phase,
        requestId,
        fromSession: input.sessionId,
        toSession: agentName,
        fromModel: this.deps.textModel,
        toModel: `${model.provider}/${model.id}`,
        outcome,
      });
    let paneId: string | undefined = reuse?.paneId;
    // Every non-ok outcome: record state first, then close the pane best effort.
    // A reused session that failed is no longer trusted: drop it so the next image starts clean.
    const fail = async (
      status: RequestState,
      outcome: LineageOutcome,
      why: string,
      reason?: string,
    ): Promise<VisionDelegateOutput> => {
      lineage("back", outcome);
      await this.writeState(reqDir, { requestId, status, paneId, reason });
      if (reuse) this.forget(input.sessionId);
      if (paneId !== undefined) {
        try {
          await herdr.closePane(paneId);
        } catch {
          // Best effort: a pane that will not close never changes the answer.
        }
      }
      return this.failure(input, images, why, restarted);
    };

    try {
      await this.writeRequestFiles(reqDir, request, input);
      await this.writeState(reqDir, { requestId, status: "waiting", paneId });
      lineage("out", "ok");
      if (reuse) {
        await herdr.prompt(reuse.paneId, reusePrompt(reqDir, request), PROMPT_TIMEOUT_MS);
      } else if ("originPaneId" in via) {
        await mkdir(sessionDir, { recursive: true });
        const split = await herdr.splitPane?.({ paneId: via.originPaneId, cwd: input.cwd, direction: "right" });
        if (!split) throw new Error("this herdr client cannot split panes");
        paneId = split.paneId;
        await this.writeState(reqDir, { requestId, status: "waiting", paneId });
        await herdr.startAgent(paneId, "pi", agentName, [
          "--provider",
          model.provider,
          "--model",
          model.id,
          "--session-dir",
          sessionDir,
          "--append-system-prompt",
          join(reqDir, "role-prompt.md"),
          `@${join(reqDir, "instructions.md")}`,
          `@${join(reqDir, "handoff.md")}`,
          ...images.map((i) => `@${i.path}`),
        ]);
      }
    } catch (err) {
      const step = reuse ? "prompting the open vision session" : "starting the vision pane";
      return fail("failed", "failed", `${step} failed (${errText(err)})`, errText(err));
    }
    if (paneId === undefined) return fail("failed", "failed", "no vision pane was available");

    safeStatus(input, "analyzing image…");
    let outcome: WaitOutcome;
    try {
      outcome = await this.waitForResult(reqDir, request, paneId, input.signal);
    } catch (err) {
      outcome = { kind: "invalid", reason: errText(err) };
    } finally {
      safeStatus(input, undefined);
    }

    if (outcome.kind === "result") {
      const { result } = outcome;
      lineage("back", result.status);
      await this.writeState(reqDir, { requestId, status: "done", paneId, resultStatus: result.status });
      if (!reuse) {
        try {
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

  private forget(sessionId: string): void {
    try {
      this.deps.registry.remove(sessionId);
    } catch {
      // A locked registry only risks one more stale check later (getAgent catches it).
    }
  }

  private async waitForResult(
    reqDir: string,
    request: VisionRequest,
    paneId: string,
    signal?: AbortSignal,
  ): Promise<WaitOutcome> {
    const file = resultPath(reqDir, request.requestId);
    const deadline = this.deps.now() + this.deps.settings.waitSeconds * 1000;
    // Missing, half-written, unparseable, or for another request: undefined, keep waiting.
    const check = async (): Promise<WaitOutcome | undefined> => {
      const seen = await readResult(file);
      if (seen === undefined || !isRecord(seen) || seen.request_id !== request.requestId) return undefined;
      const parsed = parseResult(seen, request);
      return parsed.ok ? { kind: "result", result: parsed.result } : { kind: "invalid", reason: parsed.reason };
    };
    for (let poll = 1; ; poll++) {
      if (signal?.aborted) return { kind: "cancelled" };
      const seen = await check();
      if (seen) return seen;
      if (poll % PANE_CHECK_EVERY === 0) {
        let agent: unknown;
        try {
          agent = await this.deps.herdr.getAgent(paneId);
        } catch {
          agent = undefined; // transient herdr error: not proof the pane is gone
        }
        // R12: a result written just before the pane exited still counts.
        if (agent === null) return (await check()) ?? { kind: "pane_dead" };
      }
      if (this.deps.now() >= deadline) return { kind: "timeout" };
      await this.deps.sleep(POLL_MS);
    }
  }

  private async writeRequestFiles(reqDir: string, request: VisionRequest, input: VisionDelegateInput): Promise<void> {
    const handoff = buildSessionHandoff({ sessionId: input.sessionId, messages: input.messages });
    const ask = input.text.trim() ? input.text : "(The user sent the image(s) with no accompanying text.)";
    const handoffText = handoff.ok
      ? `${handoff.rendered}\n\n## The user's message with the image(s)\n\n${ask}\n`
      : `Note: no session context was available (${handoff.error}).\n\n## The user's message with the image(s)\n\n${ask}\n`;
    const result = resultPath(reqDir, request.requestId);
    const instructions = [
      "# Vision request",
      "",
      `Request id: ${request.requestId}`,
      `Request file: ${join(reqDir, "request.json")}`,
      `Result file (write here, via a temporary file and rename): ${result}`,
      "",
      "Read request.json for the image paths and sha256 hashes. Copy them back exactly in the result.",
      "",
      "Images:",
      ...request.images.map((i) => `- ${i.path} (sha256 ${i.sha256})`),
      "",
    ].join("\n");
    await mkdir(join(reqDir, "results"), { recursive: true });
    await atomicWrite(join(reqDir, "handoff.md"), handoffText);
    await atomicWrite(join(reqDir, "request.json"), buildRequestFile(request));
    await atomicWrite(join(reqDir, "instructions.md"), instructions);
    await atomicWrite(join(reqDir, "role-prompt.md"), VISION_ROLE_PROMPT);
  }

  private async writeState(
    reqDir: string,
    s: { requestId: string; status: RequestState; paneId?: string; reason?: string; resultStatus?: string },
  ): Promise<void> {
    const body: Record<string, unknown> = {
      request_id: s.requestId,
      status: s.status,
      injected: s.status === "done",
      updated_at: new Date(this.deps.now()).toISOString(),
    };
    if (s.paneId !== undefined) body.pane_id = s.paneId;
    if (s.reason !== undefined) body.reason = s.reason;
    if (s.resultStatus !== undefined) body.result_status = s.resultStatus;
    try {
      await atomicWrite(join(reqDir, "state.json"), `${JSON.stringify(body, null, 2)}\n`);
    } catch {
      // state.json is a record, not a gate; failing to write it never changes the answer.
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

/** Short instructions and absolute paths only: never the handoff body or image data. */
function reusePrompt(reqDir: string, request: VisionRequest): string {
  return [
    `New vision request ${request.requestId}.`,
    `Read ${join(reqDir, "instructions.md")}, ${join(reqDir, "request.json")} and ${join(reqDir, "handoff.md")},`,
    `then examine the image(s) with your read tool: ${request.images.map((i) => i.path).join(", ")}.`,
    `Write the result for request ${request.requestId} to ${resultPath(reqDir, request.requestId)}`,
    "(temporary file, then rename). Earlier requests are finished; do not rewrite their results.",
  ].join(" ");
}

function safeStatus(input: VisionDelegateInput, text: string | undefined): void {
  try {
    input.status?.(text);
  } catch {
    // A broken status line must never break the delegation.
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readResult(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function atomicWrite(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}
