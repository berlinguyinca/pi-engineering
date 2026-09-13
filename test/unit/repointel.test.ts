import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { buildSymbolIndex, findSymbol, isSourceFile, symbolIndex } from "../../src/intel/RepoIntel.ts";

test("repointel: isSourceFile filters non-source paths", () => {
  assert.equal(isSourceFile("src/a.ts"), true);
  assert.equal(isSourceFile("src/a.js"), true);
  assert.equal(isSourceFile("src/a.md"), false);
  assert.equal(isSourceFile("node_modules/x/a.ts"), false);
});

test("repointel: buildSymbolIndex extracts functions, classes, consts, exports", () => {
  const index = buildSymbolIndex([
    {
      path: "src/add.ts",
      content: "export function add(a, b) { return a + b; }\nexport class Adder {}\nexport const TWO = 2;",
    },
  ]);
  assert.equal(findSymbol(index, "add")[0]?.kind, "function");
  assert.equal(findSymbol(index, "Adder")[0]?.kind, "class");
  assert.equal(findSymbol(index, "TWO")[0]?.kind, "const");
  assert.equal(findSymbol(index, "add")[0]?.file, "src/add.ts");
  assert.equal(findSymbol(index, "add")[0]?.line, 1);
});

test("repointel: symbolIndex walks a real repo and finds symbols", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(join((await import("node:os")).tmpdir(), "pi-intel-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "src", "util.ts"), "export function isEven(n) { return n % 2 === 0; }\n");
    const index = await symbolIndex(root, ["src"]);
    assert.equal(findSymbol(index, "isEven").length, 1);
    assert.equal(findSymbol(index, "isEven")[0]?.file, "src/util.ts");
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});
