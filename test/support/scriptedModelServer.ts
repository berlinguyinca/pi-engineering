/**
 * A small scripted OpenAI-compatible chat-completions server (real HTTP, no network).
 *
 * The script is a pure function of the conversation so far: it sees the system
 * text, the tool names offered and every tool result, and answers with either a
 * tool call or final text. It is stateless on purpose, so a retried or repeated
 * request gets the same answer. Used to drive a REAL omp process offline.
 */
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface ScriptTurn {
  /** Concatenated system/developer message text. */
  system: string;
  /** Text of the last user message. */
  user: string;
  /** Tool names offered on this request. */
  toolNames: string[];
  /** Assistant messages already in the history. */
  assistantTurns: number;
  /** Tool-call names the assistant has already made, in order. */
  priorCalls: string[];
  /** Text of every tool result so far, in order. */
  toolResults: string[];
}

export type ScriptReply =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; args: Record<string, unknown> }
  | { kind: "hang" };

export type ModelScript = (turn: ScriptTurn) => ScriptReply;

export interface ScriptedModelServer {
  readonly port: number;
  readonly baseUrl: string;
  /** Every agent turn the server answered, as seen by the script. */
  readonly turns: ScriptTurn[];
  close(): Promise<void>;
}

interface ChatMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string } }>;
}

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === "object" && p !== null ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("");
  }
  return "";
};

export function toTurn(body: {
  messages?: ChatMessage[];
  tools?: Array<{ function?: { name?: string } }>;
}): ScriptTurn {
  const msgs = body.messages ?? [];
  const lastUser = [...msgs].reverse().find((m) => m.role === "user");
  return {
    system: msgs
      .filter((m) => m.role === "system" || m.role === "developer")
      .map((m) => textOf(m.content))
      .join("\n"),
    user: textOf(lastUser?.content),
    toolNames: (body.tools ?? []).map((t) => t.function?.name ?? ""),
    assistantTurns: msgs.filter((m) => m.role === "assistant").length,
    priorCalls: msgs.flatMap((m) =>
      m.role === "assistant" ? (m.tool_calls ?? []).map((c) => c.function?.name ?? "") : [],
    ),
    toolResults: msgs.filter((m) => m.role === "tool").map((m) => textOf(m.content)),
  };
}

export async function startScriptedModel(script: ModelScript): Promise<ScriptedModelServer> {
  const turns: ScriptTurn[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "scripted", object: "model" }] }));
        return;
      }
      if (!req.url?.includes("/chat/completions")) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Parameters<typeof toTurn>[0];
      const turn = toTurn(body);
      turns.push(turn);
      const reply = script(turn);
      if (reply.kind === "hang") return; // never answers: models a stuck provider
      const prompt = 400 + turns.length * 100;
      const usage = { prompt_tokens: prompt, completion_tokens: 40, total_tokens: prompt + 40 };
      const base = { id: `chatcmpl-s${turns.length}`, object: "chat.completion.chunk", created: 0, model: "scripted" };
      const tool =
        reply.kind === "tool"
          ? [
              {
                index: 0,
                id: `call_${turns.length}`,
                type: "function",
                function: { name: reply.name, arguments: JSON.stringify(reply.args) },
              },
            ]
          : undefined;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: reply.kind === "text" ? reply.text : null,
              ...(tool ? { tool_calls: tool } : {}),
            },
            finish_reason: null,
          },
        ],
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }] });
      send({ ...base, choices: [], usage });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    turns,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
