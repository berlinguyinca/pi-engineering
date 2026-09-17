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
  return { root, cleanup: () => cleanupFixture(root) };
}

/**
 * Remove the fixture repo AND the sibling worktrees GitRepo.createWorktree
 * places next to it (`<tmpdir>/pi-eng-<shortHash(root>>-<branch>`).
 *
 * Those directories live OUTSIDE the repo root, so `rm(root)` leaves them
 * behind. A run that isolates mutating tasks in worktrees therefore litters the
 * system tmp dir with hundreds of stale trees, which slows later runs and makes
 * worktree tests contend. The path prefix is derived from the fixture's own root
 * with the same hash GitRepo uses, so this can never touch another repo's
 * worktrees.
 */
async function cleanupFixture(root: string): Promise<void> {
  const prefix = `pi-eng-${shortHash(root)}-`;
  const parent = dirname(root);
  await rm(root, { recursive: true, force: true });
  try {
    const { readdir } = await import("node:fs/promises");
    for (const name of await readdir(parent)) {
      if (name.startsWith(prefix)) {
        await rm(join(parent, name), { recursive: true, force: true }).catch(() => {});
      }
    }
  } catch {
    // Best effort.
  }
}

/** Mirrors GitRepo's path-shortening hash so cleanup matches its worktree paths. */
function shortHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

async function mkdtemp(): Promise<string> {
  const base = join(tmpdir(), "pi-eng-fixture-");
  return (await import("node:fs/promises")).mkdtemp(base);
}

async function write(p: string, content: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content);
}
