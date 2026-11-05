import assert from "node:assert/strict";
import { test } from "node:test";
import { runWithInferenceInvocation } from "../../src/inference/inferenceContext.ts";
import { resolveRequestBodyBudgetConfig } from "../../src/request/bodyBudget.ts";
import { guardRuntimeRequestBody } from "../../src/workers/requestBodyGuard.ts";

/** The maxTokens a guarded runtime hands its provider, for a model registered at `registered`. */
function sentTo(invocation: { maxOutputTokens?: number; maxTokens?: number } | undefined, registered = 4_096) {
  let sent: unknown = "unset";
  const runtime = {
    streamSimple: (_m: unknown, _c: unknown, options?: { maxTokens?: number }) => {
      sent = options?.maxTokens;
      return { async *[Symbol.asyncIterator]() {}, result: async () => ({}) };
    },
  };
  guardRuntimeRequestBody(runtime as never, resolveRequestBodyBudgetConfig({}));
  const call = () =>
    (runtime.streamSimple as (...a: unknown[]) => { result: () => Promise<unknown> })(
      { id: "m", provider: "p", maxTokens: registered },
      { messages: [] },
      undefined,
    ).result();
  return (async () => {
    await (invocation ? runWithInferenceInvocation({ role: "implementer", ...invocation }, call) : call());
    return sent;
  })();
}

test("the retry's allowance override reaches the provider, and the invocation cap still bounds it", async () => {
  assert.equal(await sentTo(undefined), undefined, "no override: Pi's own allowance applies");
  assert.equal(await sentTo({ maxTokens: 8_192 }), 8_192);
  assert.equal(await sentTo({ maxTokens: 8_192, maxOutputTokens: 6_000 }), 6_000, "cap lower than the raised value");
  assert.equal(await sentTo({ maxOutputTokens: 1_000 }), 1_000, "cap alone still clamps the registered allowance");
  assert.equal(await sentTo({ maxOutputTokens: 9_000 }), undefined, "cap above the allowance leaves it alone");
});
