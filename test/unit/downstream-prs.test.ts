import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { downstreamPrNodes } from "../../src/runtime/herdr/forkWiring.ts";

const task = (id: string, dependsOn: string[] = []) => ({ task_id: id, mission_id: "M", depends_on: dependsOn });
const link = (taskId: string, pr: string, status = "active", kind = "pr") => ({
  status,
  targetKind: kind,
  target: pr,
  subject: { kind: "task", id: taskId },
});

describe("downstreamPrNodes", () => {
  const store = {
    listTasks: () => [task("a"), task("b", ["a"]), task("c", ["b"]), task("d")],
    listGithubLinks: () => [
      link("b", "pr:github.com/o/r#2"),
      link("c", "pr:github.com/o/r#3"),
      link("d", "pr:github.com/o/r#4"),
      link("b", "pr:github.com/o/r#5", "removed"),
      link("b", "issue:github.com/o/r#6", "active", "issue"),
    ],
  };
  it("follows dependencies transitively, ignores independent tasks, removed links and issues", () => {
    assert.deepEqual(downstreamPrNodes(store, "a").sort(), ["pr:github.com/o/r#2", "pr:github.com/o/r#3"]);
    assert.deepEqual(downstreamPrNodes(store, "c"), []);
  });
  it("a dependency cycle terminates", () => {
    const cyc = { ...store, listTasks: () => [task("a", ["b"]), task("b", ["a"])] };
    assert.ok(Array.isArray(downstreamPrNodes(cyc, "a")));
  });
});
