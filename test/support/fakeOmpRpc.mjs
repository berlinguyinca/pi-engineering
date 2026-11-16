// A real child process that speaks omp's `--mode rpc` JSONL protocol, for tests that must not need the omp binary.
// It replays frames captured from omp 18.20.0 (test/fixtures/omp-frames/). FAKE_OMP_MODE selects the behaviour:
//   calls: after the prompt, issues the host tool calls in FAKE_OMP_CALLS ([[name,args],...]), appends each
//   host_tool_result frame to FAKE_OMP_RESULTS, then calls worker_result with FAKE_OMP_FINAL.
//   replay | crash-before-ready | hang-before-ready | crash-after-prompt | hang-after-prompt | no-result | prompt-error | late-burst
import { appendFileSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_OMP_MODE ?? "replay";
const fixture = process.env.FAKE_OMP_FIXTURE;
const out = (o) => process.stdout.write(`${typeof o === "string" ? o : JSON.stringify(o)}\n`);
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  out("omp/18.20.0");
  process.exit(0);
}
// FAKE_OMP_LOG: one JSON line per process start (argv without the script) so tests can count processes.
if (process.env.FAKE_OMP_LOG)
  appendFileSync(
    process.env.FAKE_OMP_LOG,
    `${JSON.stringify({ pid: process.pid, argv: argv.slice(1), depth: process.env.PI_MISSION_DEPTH })}\n`,
  );
if (process.env.FAKE_OMP_EXPECT_HOME && process.env.HOME !== process.env.FAKE_OMP_EXPECT_HOME) process.exit(5);
if (mode === "crash-before-ready") process.exit(3);
if (mode === "hang-before-ready") setInterval(() => {}, 1000);
else {
  const frames = readFileSync(fixture, "utf8").split("\n").filter(Boolean);
  const ready = frames.find((l) => JSON.parse(l).type === "ready");
  out(ready);
  let pending = null;
  const awaitResult = () =>
    new Promise((r) => {
      pending = r;
    });
  const playCalls = async () => {
    const calls = JSON.parse(process.env.FAKE_OMP_CALLS ?? "[]");
    calls.push(["worker_result", JSON.parse(process.env.FAKE_OMP_FINAL ?? "{}")]);
    for (const [i, [toolName, args]] of calls.entries()) {
      out({ type: "host_tool_call", id: `h${i}`, toolCallId: `tc${i}`, toolName, arguments: args });
      await awaitResult();
    }
    out({ type: "prompt_result", status: "completed" });
  };
  const play = async () => {
    if (mode === "calls") return playCalls();
    if (mode === "late-burst") await new Promise((r) => setTimeout(r, 600));
    for (const line of frames) {
      const f = JSON.parse(line);
      if (f.type === "ready" || f.type === "response") continue;
      if (
        (mode === "no-result" || mode === "prompt-error") &&
        (f.type === "host_tool_call" || f.toolName === "worker_result")
      )
        continue;
      if (mode === "crash-after-prompt" && f.type === "host_tool_call") process.exit(4);
      if (mode === "hang-after-prompt" && f.type === "host_tool_call") return;
      if (mode === "prompt-error" && f.type === "prompt_result") {
        out({ ...f, status: "error", error: "provider exploded" });
        continue;
      }
      out(line);
      if (f.type === "host_tool_call")
        await new Promise((r) => {
          pending = r;
        });
    }
  };
  createInterface({ input: process.stdin }).on("line", (line) => {
    const cmd = JSON.parse(line);
    if (cmd.type === "negotiate_protocol")
      out({
        id: cmd.id,
        type: "response",
        command: "negotiate_protocol",
        success: true,
        data: { protocolVersion: cmd.protocolVersion },
      });
    else if (cmd.type === "get_state") {
      // FAKE_OMP_STATE: "window:<n>" answers with that model context window; "nowindow" omits it; "error" fails.
      const st = process.env.FAKE_OMP_STATE ?? "";
      if (st.startsWith("window:"))
        out({
          id: cmd.id,
          type: "response",
          command: "get_state",
          success: true,
          data: { model: { id: "scripted", contextWindow: Number(st.slice(7)) } },
        });
      else if (st === "nowindow")
        out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { model: { id: "scripted" } } });
      else if (st === "error")
        out({ id: cmd.id, type: "response", command: "get_state", success: false, error: "no state" });
    } else if (cmd.type === "set_host_tools") {
      if (process.env.FAKE_OMP_RESULTS) appendFileSync(process.env.FAKE_OMP_RESULTS, `${line}\n`);
      out({ id: cmd.id, type: "response", command: "set_host_tools", success: true, data: {} });
    } else if (cmd.type === "prompt") {
      out({ id: cmd.id, type: "response", command: "prompt", success: true });
      void play();
    } else if (cmd.type === "host_tool_result") {
      if (process.env.FAKE_OMP_RESULTS) appendFileSync(process.env.FAKE_OMP_RESULTS, `${line}\n`);
      pending?.();
    }
  });
}
