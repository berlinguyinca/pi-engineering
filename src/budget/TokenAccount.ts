import type { WorkerUsage } from "../core/types.ts";

const reported = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const add = (sum: number | null, v: unknown): number | null => {
  const n = reported(v);
  return n === undefined ? sum : (sum ?? 0) + n;
};

/**
 * The one token record of a task, summed over every request of every attempt
 * (retries and compactions included). A field no provider reported is `null`,
 * never 0. `thinking` is a SUBSET of `output` (OpenAI-style completion_tokens
 * already include reasoning), so `total` is input + output and never adds it.
 */
export class TokenAccount {
  private input: number | null = null;
  private output: number | null = null;
  private thinking: number | null = null;
  private cacheRead = 0;
  private cacheWrite = 0;
  private cost = 0;
  private contextTokens = 0;
  private turns = 0;
  private model = "";
  private compactions = 0;
  private maxTokens: number | null = null;

  /** Add the assistant messages of one session. */
  addMessages(messages: readonly { role: string }[]): this {
    for (const msg of messages) {
      if (msg.role !== "assistant") continue;
      const m = msg as { usage?: Record<string, any>; model?: string };
      const u = m.usage;
      if (!u) continue;
      this.input = add(this.input, u.input);
      this.output = add(this.output, u.output);
      this.thinking = add(this.thinking, u.reasoning);
      this.cacheRead += reported(u.cacheRead) ?? 0;
      this.cacheWrite += reported(u.cacheWrite) ?? 0;
      this.cost += reported(u.cost?.total) ?? 0;
      this.contextTokens = Math.max(this.contextTokens, reported(u.totalTokens) ?? 0);
      this.turns++;
      if (m.model) this.model = m.model;
    }
    return this;
  }

  /** Compactions run by a session. */
  addCompactions(n: number): void {
    this.compactions += n;
  }

  /** The output allowance a request was sent with; the largest one is kept. */
  useAllowance(maxTokens: number | undefined): void {
    const n = reported(maxTokens);
    if (n !== undefined) this.maxTokens = Math.max(this.maxTokens ?? 0, n);
  }

  usage(streamResumes = 0): WorkerUsage | null {
    if (this.turns === 0) return null;
    return {
      input: this.input,
      output: this.output,
      thinking: this.thinking,
      total: this.input === null && this.output === null ? null : (this.input ?? 0) + (this.output ?? 0),
      compactions: this.compactions,
      maxTokens: this.maxTokens,
      cacheRead: this.cacheRead,
      cacheWrite: this.cacheWrite,
      cost: this.cost,
      contextTokens: this.contextTokens,
      turns: this.turns,
      model: this.model,
      ...(streamResumes > 0 ? { streamResumes } : {}),
    };
  }
}
