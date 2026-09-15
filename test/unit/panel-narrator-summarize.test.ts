import assert from "node:assert/strict";
import { test } from "node:test";
import { type SummarizeRuntime, createSummarize } from "../../src/panel/narrator/summarize.ts";

/** A stand-in stream: yields the given events, then resolves to `final`. */
function fakeStream(events: unknown[], final: unknown) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => final,
  };
}

function runtime(
  stream: ReturnType<typeof fakeStream>,
  models: unknown[] = [{ id: "m1" }],
): () => Promise<SummarizeRuntime> {
  return async () => ({
    getAvailable: async () => models,
    streamSimple: () => stream,
  });
}

test("summarize: the assembled text comes back from the stream result", async () => {
  const summarize = createSummarize({
    runtime: runtime(fakeStream([{ type: "start" }, { type: "done" }], { content: "we did a thing" })),
  });
  assert.equal(await summarize("prompt"), "we did a thing");
});

test("summarize: content parts are joined, not stringified", async () => {
  const summarize = createSummarize({
    runtime: runtime(
      fakeStream([{ type: "done" }], {
        content: [
          { type: "text", text: "first " },
          { type: "text", text: "second" },
        ],
      }),
    ),
  });
  assert.equal(await summarize("prompt"), "first second");
});

test("summarize: a non-text content part is skipped rather than rendered", async () => {
  const summarize = createSummarize({
    runtime: runtime(
      fakeStream([{ type: "done" }], {
        content: [
          { type: "thinking", text: "hmm" },
          { type: "text", text: "said" },
        ],
      }),
    ),
  });
  assert.equal(await summarize("prompt"), "said");
});

test("summarize: an error event throws, so the narrator keeps the old narrative", async () => {
  const summarize = createSummarize({
    runtime: runtime(fakeStream([{ type: "error", errorMessage: "429 queue_timeout" }], { content: "" })),
  });
  await assert.rejects(() => summarize("prompt"), /queue_timeout/);
});

test("summarize: no text produced is a failure, not an empty narrative", async () => {
  const summarize = createSummarize({ runtime: runtime(fakeStream([{ type: "done" }], { content: "" })) });
  await assert.rejects(() => summarize("prompt"), /no text/i);
});

test("summarize: a result shape it does not recognise is a failure, not silence", async () => {
  // This is the failure that would otherwise be invisible: a changed message
  // shape means the tab simply never fills in, with nothing logged anywhere.
  const summarize = createSummarize({ runtime: runtime(fakeStream([{ type: "done" }], { unexpected: true })) });
  await assert.rejects(() => summarize("prompt"), /no text/i);
});

test("summarize: no available model is reported rather than hanging", async () => {
  const summarize = createSummarize({
    runtime: runtime(fakeStream([], { content: "" }), []),
  });
  await assert.rejects(() => summarize("prompt"), /no model available/i);
});

test("summarize: the prompt reaches the model unchanged", async () => {
  let seen: unknown;
  const summarize = createSummarize({
    runtime: async () => ({
      getAvailable: async () => [{ id: "m1" }],
      streamSimple: (_model: never, context: never) => {
        seen = context;
        return fakeStream([{ type: "done" }], { content: "ok" });
      },
    }),
  });
  await summarize("the prompt body");
  const messages = (seen as { messages?: { content?: string }[] }).messages ?? [];
  assert.equal(messages[0]?.content, "the prompt body");
});
