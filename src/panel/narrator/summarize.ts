/**
 * The narrator's model seam, wired to a real model.
 *
 * Kept out of `Narrator.ts` on purpose: everything worth testing about the
 * narrative (deltas, debouncing, the admission gate, failure behaviour) is in
 * that file and needs no model, and everything that needs a model is here.
 *
 * This is a one-shot text completion with no tools. It is NOT an agent
 * session: it cannot call tools, cannot touch a worktree, and its only output
 * is a paragraph of prose. A failure throws, which the `Narrator` turns into
 * "keep the previous narrative" — the specified behaviour for a narrative that
 * could not be updated.
 */

import type { Model } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { registerLocalProviders } from "../../workers/localProviders.ts";

/** The slice of a ModelRuntime this adapter uses (injected in tests). */
export interface SummarizeRuntime {
  getAvailable(): Promise<readonly unknown[]>;
  streamSimple(model: never, context: never): AsyncIterable<unknown> & { result(): Promise<unknown> };
}

export interface SummarizeOptions {
  /** Agent profile directory holding auth.json / models.json. */
  agentDir?: string;
  /** Pin the narrator's model. Defaults to the first available. */
  model?: Model<never>;
  allowModelNetwork?: boolean;
  /**
   * Inject the runtime. Without this the adapter builds a real `ModelRuntime`,
   * which is exactly what a test must not do — and what would otherwise leave
   * the only model-touching code in the panel unexercised.
   */
  runtime?: () => Promise<SummarizeRuntime>;
}

function joinExpand(base: string, file: string): string {
  const root = base.startsWith("~") ? `${process.env.HOME ?? ""}${base.slice(1)}` : base;
  return `${root.replace(/\/+$/, "")}/${file}`;
}

/**
 * Build the `summarize` function the `Narrator` calls.
 *
 * The runtime is created lazily and once: a session that never opens the panel
 * never builds one.
 */
export function createSummarize(opts: SummarizeOptions = {}): (prompt: string) => Promise<string> {
  const agentDir = opts.agentDir ?? process.env.PI_AGENT_DIR ?? "~/.pi/agent";
  let runtimePromise: Promise<SummarizeRuntime> | undefined;

  const getRuntime = (): Promise<SummarizeRuntime> => {
    if (opts.runtime) return opts.runtime();
    runtimePromise ??= (async () => {
      const runtime = await ModelRuntime.create({
        authPath: joinExpand(agentDir, "auth.json"),
        modelsPath: joinExpand(agentDir, "models.json"),
        allowModelNetwork: opts.allowModelNetwork ?? false,
      });
      await registerLocalProviders(runtime).catch(() => {});
      return runtime as unknown as SummarizeRuntime;
    })();
    return runtimePromise;
  };

  return async (prompt: string): Promise<string> => {
    const runtime = await getRuntime();
    const model = opts.model ?? ((await runtime.getAvailable())[0] as Model<never> | undefined);
    if (!model) throw new Error("no model available for the session narrative");

    const stream = runtime.streamSimple(
      model as never,
      {
        messages: [{ role: "user", content: prompt, timestamp: new Date().toISOString() }],
      } as never,
    );

    for await (const event of stream) {
      const e = event as { type?: string; errorMessage?: string };
      if (e.type === "error") throw new Error(e.errorMessage ?? "narrative stream failed");
    }
    // The assembled message comes from the stream's own result rather than from
    // re-accumulating deltas.
    const final = (await stream.result()) as { content?: unknown } | undefined;
    const text = extractText(final?.content);
    if (!text) throw new Error("narrative stream produced no text");
    return text;
  };
}

/** Pull plain text out of a message content union, defensively. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      const p = part as { type?: string; text?: unknown };
      return p.type === "text" && typeof p.text === "string" ? p.text : "";
    })
    .join("");
}
