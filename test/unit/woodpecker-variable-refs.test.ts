/**
 * `.woodpecker/*.yaml` is a shell script wearing a YAML coat, and the two languages
 * disagree about `${VAR}`.
 *
 * Woodpecker expands braced references in the YAML text against **its own** variable
 * table — the `CI_*` built-ins and declared variables — before the step runs, and blanks
 * anything that is not in that table. A container environment variable is not in that
 * table. So `[ -x "${GIT_ASKPASS}" ]` reaches the shell as `[ -x "" ]`: a guard that
 * always fails, on a machine where the variable is set.
 *
 * This is not a hypothetical. A checkout step written with `${GIT_ASKPASS}` failed with
 * exit 1 and produced no log output at all, which reads as an infrastructure problem and
 * sends the next person looking for a broken agent. `.woodpecker/ci.yaml` documents the
 * rule in a comment; the comment did not stop the author of the comment from writing the
 * plain form three lines later, which is why this is a test.
 *
 * The rule: a plain `${NAME}` must be something Woodpecker actually knows (`CI_*`). A
 * shell or container variable uses an operator form — `${NAME:-}`, `${NAME:+set}` — which
 * Woodpecker leaves alone and the shell evaluates, or the unbraced `$NAME`.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parse as parseYaml } from "yaml";

const PIPELINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".woodpecker");

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/g;

/** Every string leaf of a parsed document, with a path for the failure message. */
function textLeaves(node: unknown, at: string, into: Array<{ at: string; text: string }>): void {
  if (typeof node === "string") {
    into.push({ at, text: node });
  } else if (Array.isArray(node)) {
    node.forEach((child, i) => textLeaves(child, `${at}[${i}]`, into));
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) textLeaves(value, `${at}.${key}`, into);
  }
}

test("no pipeline step asks Woodpecker to expand a variable it does not know", async () => {
  const files = (await readdir(PIPELINE_DIR)).filter((f) => f.endsWith(".yaml")).sort();
  assert.ok(files.length >= 2, `expected at least the ci and release-gate pipelines, saw: ${files.join(", ")}`);

  const offenders: string[] = [];
  let operatorRefs = 0;
  for (const file of files) {
    const doc = parseYaml(await readFile(join(PIPELINE_DIR, file), "utf8"));
    const leaves: Array<{ at: string; text: string }> = [];
    textLeaves(doc, file, leaves);
    assert.ok(leaves.length > 10, `${file}: the walk found almost nothing; the test would pass vacuously`);
    for (const { at, text } of leaves) {
      for (const match of text.matchAll(REF)) {
        const [, name, rest] = match;
        // A reference with an operator (`:-`, `:+`, `#`, `%%`, …) is left alone by
        // Woodpecker and evaluated by the shell, which is the point.
        if (rest !== "") operatorRefs++;
        else if (!/^CI_/.test(name)) offenders.push(`${file}: \${${name}}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `${offenders.join(", ")} — Woodpecker expands \${VAR} from its own table and blanks what it does not ` +
      `know, so a container variable arrives at the shell as an empty string. Use \${VAR:-} (or plain $VAR) ` +
      `for anything the agent puts in the environment.`,
  );
  // Guards the walk itself: if the parser or the directory ever stops yielding the
  // step text, the assertion above would pass by finding nothing.
  assert.ok(operatorRefs >= 10, `only ${operatorRefs} braced references found; the walk is not seeing step text`);
});
