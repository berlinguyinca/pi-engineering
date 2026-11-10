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
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

// A note for whoever debugs a checkout that dies in one second with no log output at
// all, including from steps that succeeded: check `gh api .../pulls/N --jq
// .merge_commit_sha` first. Woodpecker checks out refs/pull/N/merge, and GitHub rebuilds
// that ref lazily — while mergeability is `unknown` the ref can be missing or point at a
// merge of an older head. Both cases look identical to a broken pipeline config, and three
// runs here were attributed to a `${VAR}` bug that a previous commit had already fixed.
const PIPELINE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".woodpecker");

/** The message every offender gets, kept out of the assert so it stays readable. */
const HINT = [
  "Woodpecker expands brace references from its own table — the CI_* built-ins and declared",
  "variables — and blanks the rest, so a container variable arrives at the shell as an empty",
  "string. For anything the agent puts in the environment, use the colon-plus presence form or",
  "plain $VAR; never the plain brace form, and never a colon-dash default.",
].join(" ");

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)([^}]*)\}/g;

/**
 * Two brace shapes Woodpecker's scanner cannot parse at all. They are not a step
 * failure: the whole pipeline comes back status=error, "missing closing brace", with no
 * agent assigned and no step logs anywhere, which looks like an outage. The length form
 * (hash before the name) and the plus form without a colon. Both are valid shell.
 *
 * They are also easy to write by accident *in a comment*, because the substitution runs
 * over the raw text: a comment explaining that the length form breaks the build breaks
 * the build.
 */
const BRACE_HINT = [
  "Woodpecker's substitution scanner cannot parse these brace shapes, and it scans comments",
  "too, so documenting them in code form breaks the pipeline. Describe them in words.",
].join(" ");

const UNPARSEABLE = /\$\{#|\$\{[A-Za-z_]\w*\+[^:}]/g;

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
  const unparseable: string[] = [];
  let operatorRefs = 0;
  for (const file of files) {
    const doc = parseYaml(await readFile(join(PIPELINE_DIR, file), "utf8"));
    const leaves: Array<{ at: string; text: string }> = [];
    textLeaves(doc, file, leaves);
    assert.ok(leaves.length > 10, `${file}: the walk found almost nothing; the test would pass vacuously`);
    for (const { at, text } of leaves) {
      for (const bad of text.matchAll(UNPARSEABLE)) unparseable.push(`${file}: ${bad[0] ?? "?"}…`);
      for (const match of text.matchAll(REF)) {
        // Destructuring would type them `string | undefined` under
        // noUncheckedIndexedAccess; index explicitly with a default instead.
        const name = match[1] ?? "";
        const rest = match[2] ?? "";
        // A reference with an operator (`:-`, `:+`, `#`, `%%`, …) is left alone by
        // Woodpecker and evaluated by the shell, which is the point.
        if (rest === "") {
          if (!/^CI_/.test(name)) offenders.push(`${file}: \${${name}} (plain — Woodpecker substitutes it)`);
          else operatorRefs++;
        } else if (!/^CI_/.test(name) && !/^:\+/.test(rest)) {
          // Proven on the agent, not inferred: for the same variable, `${GIT_ASKPASS:-}`
          // arrived empty while `${GIT_ASKPASS:+set}` saw the value. A colon-dash default
          // is filled from Woodpecker's table, so a container variable becomes "" and a
          // guard built on it silently always fails.
          offenders.push(`${file}: \${${name}:${rest} (colon-dash is substituted; use \${${name}:+word} or $${name}})`);
        } else operatorRefs++;
      }
    }
  }

  assert.deepEqual(offenders, [], `${offenders.join(", ")} — ${HINT}`);
  assert.deepEqual(unparseable, [], `${unparseable.join(", ")} — ${BRACE_HINT}`);
  // Guards the walk itself: if the parser or the directory ever stops yielding the
  // step text, the assertion above would pass by finding nothing.
  assert.ok(operatorRefs >= 10, `only ${operatorRefs} braced references found; the walk is not seeing step text`);
});
