// Fake OpenAI-compatible server scripting a worker through: session 1 (edit+commit, then context inflation), session 2+ (verify checkpoint, finish).
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeLog {
  n: number;
  session: number;
  turn: number;
  kind: string;
  promptTokens: number;
  toolCall?: string;
  lastToolResult?: string;
  model: string;
}
const bashCall = (command: string) => ({ name: "bash", args: { command } });

export async function startFake(opts: { window: number; crossFraction: number }) {
  const log: FakeLog[] = [];
  let sessions = 0;
  const cross = Math.ceil(opts.window * (opts.crossFraction + 0.05));
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "smoke-model", object: "model" }] }));
      return;
    }
    if (!req.url?.includes("/chat/completions")) {
      res.writeHead(404);
      res.end("{}");
      return;
    }
    const body = JSON.parse(raw);
    const msgs: any[] = body.messages ?? [];
    const toolNames: string[] = (body.tools ?? []).map((t: any) => t.function?.name ?? t.name);
    const assistants = msgs.filter((m) => m.role === "assistant").length;
    const lastUser = [...msgs].reverse().find((m) => m.role === "user");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    const lastTool = [...msgs].reverse().find((m) => m.role === "tool");
    const lastToolResult = lastTool
      ? String(typeof lastTool.content === "string" ? lastTool.content : JSON.stringify(lastTool.content)).slice(0, 400)
      : undefined;
    const entry: FakeLog = {
      n: log.length + 1,
      session: 0,
      turn: 0,
      kind: "",
      promptTokens: 0,
      model: body.model,
      lastToolResult,
    };
    let call: { name: string; args: any } | undefined;
    let text: string | undefined;
    let prompt = 500;
    if (toolNames.length === 1 && toolNames[0] === "bash" && /Preflight/.test(userText)) {
      entry.kind = "preflight";
      text = "READY";
    } else if (!toolNames.includes("worker_result")) {
      entry.kind = "other";
      text = "ok (fake)";
    } else {
      if (assistants === 0) sessions += 1;
      const s = sessions;
      const t = assistants + 1;
      entry.session = s;
      entry.turn = t;
      entry.kind = "worker";
      if (s === 1) {
        if (t === 1) {
          prompt = 3000;
          call = bashCall(
            `cat >> src/calc.js <<'EOT'\nfunction multiply(a, b) {\n  return a * b;\n}\nEOT\ngit add -A && git commit -q -m "worker1: add multiply (checkpoint)" && git rev-parse --short HEAD`,
          );
        } else if (t === 2) {
          prompt = 9000;
          call = bashCall("git log --oneline | head -5");
        } else if (t === 3) {
          prompt = cross;
          call = bashCall("sleep 1; echo still-working-1");
        } else {
          prompt = cross + t * 100;
          call = bashCall(`sleep 2; echo still-working-${t}`);
        }
      } else {
        if (t === 1) {
          prompt = 4000;
          call = bashCall(
            "git log --oneline | head -5; echo ---; grep -n multiply src/calc.js || echo NO-MULTIPLY-VISIBLE",
          );
        } else if (t === 2) {
          prompt = 6000;
          call = bashCall(
            `echo 'module.exports.multiply = multiply;' >> src/calc.js && git add -A && git commit -q -m "worker2: export multiply" && git rev-parse --short HEAD`,
          );
        } else {
          prompt = 7000;
          call = {
            name: "worker_result",
            args: {
              status: "completed",
              summary: "Added multiply and exported it (successor session).",
              claims: [],
              evidence_refs: [],
              new_hypotheses: [],
              proposed_tasks: [],
            },
          };
        }
      }
    }
    entry.promptTokens = prompt;
    entry.toolCall = call ? `${call.name}:${JSON.stringify(call.args).slice(0, 120)}` : undefined;
    log.push(entry);
    const completion = 40;
    const usage = { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
    const id = `chatcmpl-fake${log.length}`;
    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "smoke-model" };
    const tc = call
      ? [
          {
            index: 0,
            id: `call_${log.length}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          },
        ]
      : undefined;
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      send({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: text ?? null, ...(tc ? { tool_calls: tc } : {}) },
            finish_reason: null,
          },
        ],
      });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] });
      send({ ...base, choices: [], usage });
      res.write("data: [DONE]\n\n");
      res.end();
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ...base,
          object: "chat.completion",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: text ?? null, ...(tc ? { tool_calls: tc } : {}) },
              finish_reason: call ? "tool_calls" : "stop",
            },
          ],
          usage,
        }),
      );
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    log,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
