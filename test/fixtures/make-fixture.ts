import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Create an isolated temporary git repository that contains a small Node
 * project with a deterministic test command, ready for the vertical-slice
 * end-to-end test. Returns the repo root and a cleanup function.
 */
export async function makeFixtureRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp();
  await exec("git", ["init", "-q", root]);
  await exec("git", ["-C", root, "config", "user.email", "test@example.com"]);
  await exec("git", ["-C", root, "config", "user.name", "Test"]);

  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture-add",
        version: "0.0.1",
        private: true,
        type: "module",
        scripts: { test: "node --test" },
      },
      null,
      2,
    ),
  );

  await write(join(root, "src", "add.js"), `export function add(a, b) {\n  throw new Error("not implemented");\n}\n`);

  await write(
    join(root, "test", "add.test.js"),
    `import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.js";\n\ntest("add returns the sum", () => {\n  assert.equal(add(2, 3), 5);\n});\n`,
  );

  await exec("git", ["-C", root, "add", "-A"]);
  await exec("git", ["-C", root, "commit", "-q", "-m", "initial fixture"]);
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

async function mkdtemp(): Promise<string> {
  const base = join(tmpdir(), "pi-eng-fixture-");
  return (await import("node:fs/promises")).mkdtemp(base);
}

async function write(p: string, content: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}
