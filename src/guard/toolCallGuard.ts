/**
 * Tool-call loop guard (session review).
 *
 * The GenerationGuard watches streamed text only, so a model that calls the
 * same tool with the same arguments over and over is invisible to it — one
 * session ran the same append command 153 times. This guard sits on the
 * `tool_call` hook and:
 *
 *   - blocks a tool call identical to the previous N consecutive calls;
 *   - gives bash test/build commands a default timeout when none was set, so a
 *     hung suite cannot hold the session indefinitely;
 *   - refuses to immediately re-run a bash command that just timed out or was
 *     aborted, unless the caller deliberately raises its timeout.
 *
 * Defaults are conservative and every knob is configurable (env, see
 * resolveToolCallGuardConfig).
 */

export interface ToolCallGuardConfig {
  enabled: boolean;
  /** Identical consecutive calls allowed before the next one is blocked. */
  maxIdenticalConsecutive: number;
  /** Default timeout (seconds) applied to bash test/build commands with none set. */
  testCommandTimeoutSec: number;
}

export const DEFAULT_TOOL_CALL_GUARD_CONFIG: ToolCallGuardConfig = {
  enabled: true,
  maxIdenticalConsecutive: 8,
  testCommandTimeoutSec: 900,
};

function positiveInt(value: string | undefined, fallback: number): number {
  const n = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function resolveToolCallGuardConfig(env: NodeJS.ProcessEnv = process.env): ToolCallGuardConfig {
  return {
    enabled: !/^(0|false|off|no)$/i.test(env.PI_TOOL_CALL_GUARD ?? ""),
    maxIdenticalConsecutive: positiveInt(
      env.PI_REPEATED_TOOL_CALL_LIMIT,
      DEFAULT_TOOL_CALL_GUARD_CONFIG.maxIdenticalConsecutive,
    ),
    testCommandTimeoutSec: positiveInt(
      env.PI_BASH_TEST_TIMEOUT_SEC,
      DEFAULT_TOOL_CALL_GUARD_CONFIG.testCommandTimeoutSec,
    ),
  };
}

/** Test, build, typecheck and lint invocations across common ecosystems. */
const TEST_OR_BUILD =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|typecheck|check|lint)\b|node\s+--test\b|npx\s+(?:tsc|vitest|jest|mocha|playwright)\b|tsc\b|vitest\b|jest\b|cargo\s+(?:test|build|check|clippy)\b|go\s+(?:test|build|vet)\b|pytest\b|python3?\s+-m\s+pytest\b|make\b|mvn\b|gradle\b|\.\/gradlew\b|sbt\b|dotnet\s+(?:test|build)\b)/;

const ENDED_BY_LIMIT = /Command timed out after \d+ seconds|Command aborted/;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function bashCommand(toolName: string, input: unknown): string | undefined {
  if (toolName !== "bash") return undefined;
  const command = (input as { command?: unknown } | undefined)?.command;
  return typeof command === "string" ? command.trim() : undefined;
}

export interface ToolCallVerdict {
  block: true;
  reason: string;
}

export class ToolCallGuard {
  private readonly config: ToolCallGuardConfig;
  private lastSignature: string | undefined;
  private identicalRun = 0;
  /** The bash command that last ended by timeout/abort, with the timeout it had. */
  private interrupted: { command: string; timeout: number | undefined; how: string } | undefined;

  constructor(config: ToolCallGuardConfig = resolveToolCallGuardConfig()) {
    this.config = config;
  }

  /**
   * Inspect (and, for the default timeout, patch in place) a tool call before
   * it runs. Returns a block verdict, or undefined to let it run.
   */
  onToolCall(toolName: string, input: unknown): ToolCallVerdict | undefined {
    if (!this.config.enabled) return undefined;
    const signature = `${toolName}\u0000${stableStringify(input)}`;
    this.identicalRun = signature === this.lastSignature ? this.identicalRun + 1 : 1;
    this.lastSignature = signature;
    if (this.identicalRun > this.config.maxIdenticalConsecutive) {
      return {
        block: true,
        reason: `Blocked: identical ${toolName} call (same arguments) repeated ${this.identicalRun} times in a row. Its result will not change; inspect the previous result and change approach.`,
      };
    }

    const command = bashCommand(toolName, input);
    if (command === undefined) return undefined;
    const args = input as Record<string, unknown>;
    const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
    const interrupted = this.interrupted;
    if (interrupted && interrupted.command === command) {
      const raised = timeout !== undefined && (interrupted.timeout === undefined || timeout > interrupted.timeout);
      if (!raised) {
        return {
          block: true,
          reason: `Blocked: \`${command.slice(0, 120)}\` just ${interrupted.how}. Re-running it unchanged will do the same; narrow it (e.g. a single test file) or pass a larger explicit timeout.`,
        };
      }
      this.interrupted = undefined;
    }
    if (timeout === undefined && TEST_OR_BUILD.test(command)) args.timeout = this.config.testCommandTimeoutSec;
    return undefined;
  }

  /** Record how a tool call ended. */
  onToolResult(toolName: string, input: unknown, isError: boolean, text: string): void {
    if (!this.config.enabled) return;
    const command = bashCommand(toolName, input);
    if (command === undefined) return;
    const ended = isError ? ENDED_BY_LIMIT.exec(text)?.[0] : undefined;
    if (ended) {
      const timeout = (input as { timeout?: unknown }).timeout;
      this.interrupted = {
        command,
        timeout: typeof timeout === "number" ? timeout : undefined,
        how: ended.startsWith("Command aborted") ? "was aborted" : "timed out",
      };
    } else if (this.interrupted?.command === command) {
      this.interrupted = undefined;
    }
  }
}

interface ToolHookHost {
  on(
    event: "tool_call",
    handler: (event: { toolName: string; input: unknown }) => Promise<ToolCallVerdict | undefined>,
  ): unknown;
  on(
    event: "tool_result",
    handler: (event: { toolName: string; input: unknown; isError: boolean; content?: unknown[] }) => Promise<void>,
  ): unknown;
}

/** Attach one guard to a live session's tool_call / tool_result hooks. */
export function registerToolCallGuard(pi: ToolHookHost, guard: ToolCallGuard = new ToolCallGuard()): ToolCallGuard {
  pi.on("tool_call", async (event) => guard.onToolCall(String(event.toolName), event.input));
  pi.on("tool_result", async (event) => {
    const text = ((event.content ?? []) as { type?: string; text?: string }[])
      .map((part) => (part?.type === "text" ? (part.text ?? "") : ""))
      .join("\n");
    guard.onToolResult(String(event.toolName), event.input, !!event.isError, text);
  });
  return guard;
}
