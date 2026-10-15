import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createNumberedReadTool, createTolerantEditTool } from "../../src/workers/tolerantFileTools.ts";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tolerant-tools-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function edit(path: string, edits: Array<{ oldText: string; newText: string }>): Promise<string> {
  const tool = createTolerantEditTool(dir);
  const result = (await tool.execute("tc", { path, edits }, undefined, undefined, { cwd: dir } as never)) as {
    content: Array<{ type: string; text?: string }>;
  };
  return result.content.map((c) => c.text ?? "").join("");
}

describe("tolerant edit", () => {
  it("applies an exact match unchanged", async () => {
    await writeFile(join(dir, "a.ts"), "const a = 1;\nconst b = 2;\n");
    await edit("a.ts", [{ oldText: "const b = 2;", newText: "const b = 3;" }]);
    assert.equal(await readFile(join(dir, "a.ts"), "utf8"), "const a = 1;\nconst b = 3;\n");
  });

  it("applies a whitespace-only mismatch (trailing spaces and indentation width)", async () => {
    await writeFile(join(dir, "a.ts"), "function f() {\n    if (x) {   \n        run();\n    }\n}\n");
    await edit("a.ts", [
      { oldText: "  if (x) {\n    run();\n  }", newText: "  if (x) {\n    run();\n    stop();\n  }" },
    ]);
    assert.equal(
      await readFile(join(dir, "a.ts"), "utf8"),
      "function f() {\n    if (x) {\n        run();\n        stop();\n    }\n}\n",
    );
  });

  it("applies a CRLF mismatch and keeps CRLF endings", async () => {
    await writeFile(join(dir, "a.ts"), "one\r\ntwo\r\nthree\r\n");
    await edit("a.ts", [{ oldText: "two  \nthree", newText: "2\nthree" }]);
    assert.equal(await readFile(join(dir, "a.ts"), "utf8"), "one\r\n2\r\nthree\r\n");
  });

  it("errors on an ambiguous whitespace-only match with numbered candidate lines", async () => {
    await writeFile(join(dir, "a.ts"), "\trun();\n\nfunction g() {\n\t\trun();\n}\n");
    await assert.rejects(edit("a.ts", [{ oldText: "  run();", newText: "  stop();" }]), (error: Error) => {
      assert.match(error.message, /matches 2 places/);
      assert.match(error.message, /\b1\b.*run\(\);/);
      assert.match(error.message, /\b4\b.*run\(\);/);
      return true;
    });
    assert.equal(await readFile(join(dir, "a.ts"), "utf8"), "\trun();\n\nfunction g() {\n\t\trun();\n}\n");
  });

  it("errors with the closest candidate lines and line numbers when nothing matches", async () => {
    await writeFile(join(dir, "a.ts"), "alpha\nexport function computeTotal(items) {\n  return 1;\n}\nomega\n");
    await assert.rejects(
      edit("a.ts", [{ oldText: "export function computeTotals(items) {\n  return 2;", newText: "x" }]),
      (error: Error) => {
        assert.match(error.message, /No unique match/);
        assert.match(error.message, /2\s.*export function computeTotal\(items\)/);
        assert.match(error.message, /3\s.*return 1;/);
        return true;
      },
    );
  });
});

describe("numbered read", () => {
  it("prefixes every line with its 1-based line number", async () => {
    await writeFile(join(dir, "a.ts"), "first\nsecond\nthird");
    const tool = createNumberedReadTool(dir);
    const result = (await tool.execute("tc", { path: "a.ts" }, undefined, undefined, { cwd: dir } as never)) as {
      content: Array<{ type: string; text?: string }>;
    };
    assert.equal(result.content[0]?.text, "1\tfirst\n2\tsecond\n3\tthird");
  });

  it("honours offset when numbering and leaves the continuation notice unnumbered", async () => {
    await writeFile(join(dir, "a.ts"), "l1\nl2\nl3\nl4\nl5");
    const tool = createNumberedReadTool(dir);
    const result = (await tool.execute("tc", { path: "a.ts", offset: 2, limit: 2 }, undefined, undefined, {
      cwd: dir,
    } as never)) as { content: Array<{ type: string; text?: string }> };
    assert.equal(result.content[0]?.text, "2\tl2\n3\tl3\n\n[2 more lines in file. Use offset=4 to continue.]");
  });
});
