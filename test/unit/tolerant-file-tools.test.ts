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

describe("tolerant edit safety", () => {
  it("refuses a flattened Python oldText instead of corrupting nesting", async () => {
    const original = "def f(x):\n    if x:\n        run()\n        stop()\n    return x\n";
    await writeFile(join(dir, "a.py"), original);
    await assert.rejects(
      edit("a.py", [{ oldText: "if x:\nrun()\nstop()", newText: "if x:\nrun()\nstop()\nextra()" }]),
      (error: Error) => {
        assert.match(error.message, /No safe match/);
        assert.match(error.message, /2\t {4}if x:/);
        return true;
      },
    );
    assert.equal(await readFile(join(dir, "a.py"), "utf8"), original);
  });

  it("refuses a flattened YAML oldText", async () => {
    const original = "services:\n  web:\n    image: a\n    ports:\n      - 80\n";
    await writeFile(join(dir, "a.yml"), original);
    await assert.rejects(
      edit("a.yml", [{ oldText: "web:\nimage: a\nports:", newText: "web:\nimage: b\nports:" }]),
      /No safe match/,
    );
    assert.equal(await readFile(join(dir, "a.yml"), "utf8"), original);
  });

  it("refuses a window that mixes tab and space indentation", async () => {
    await writeFile(join(dir, "a.ts"), "{\n\tfoo();\n    bar();\n}\n");
    await assert.rejects(edit("a.ts", [{ oldText: "  foo();\n    bar();", newText: "x" }]), /mix tab and space/);
  });

  it("caps candidate output at 20 lines per candidate and about 4 KB overall", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(300)}`);
    await writeFile(join(dir, "a.ts"), lines.join("\n"));
    const oldText = lines
      .slice(0, 50)
      .map((l) => `${l}!`)
      .join("\n");
    await assert.rejects(edit("a.ts", [{ oldText, newText: "y" }]), (error: Error) => {
      assert.ok(error.message.length <= 4200, `error length ${error.message.length}`);
      assert.doesNotMatch(error.message, /\n21\t/);
      return true;
    });
  });

  it("shows context around each exact-multiple match", async () => {
    await writeFile(join(dir, "a.ts"), "a\nb\ntarget\nc\nd\ne\nf\ntarget\ng\n");
    await assert.rejects(edit("a.ts", [{ oldText: "target", newText: "t" }]), (error: Error) => {
      assert.match(error.message, /1\ta\n2\tb\n3\ttarget\n4\tc\n5\td/);
      assert.match(error.message, /6\te\n7\tf\n8\ttarget\n9\tg/);
      return true;
    });
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
