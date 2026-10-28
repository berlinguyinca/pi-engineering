import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The no-dead-emitter invariant (spec 05 §"producers must be reachable").
 *
 * The mission visibility work started because `onMissionObservabilityUpdate`
 * existed, was documented, had a reducer behind it — and nothing called it. The
 * observability state machine had been accumulating events nobody emitted. Unit
 * tests could not catch that: every piece passed on its own. The only defense is
 * a static check over the source tree that a producer is actually wired.
 *
 * Three invariants, all cheap and all deterministic:
 *
 *   1. Every public mutator on `MissionObservability` is called from at least one
 *      non-test source file outside the class itself.
 *   2. Every exported producer in `src/orchestration/*Notice.ts` is imported and
 *      called from a non-test source file outside its own module.
 *   3. Every `onXxx` callback the runtime options declare is wired by the
 *      extension that owns the session.
 *
 * Each allow-list is asserted with `deepEqual` in BOTH directions: a new unwired
 * producer fails, and a stale allow-list entry (something that got wired up)
 * fails too, so the lists cannot quietly rot into a list of excuses.
 */

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const EXTENSIONS = fileURLToPath(new URL("../../extensions/", import.meta.url));

/** Every .ts file under src/ and extensions/ — tests are deliberately excluded. */
function sourceFiles(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push({ path: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(SRC);
  walk(EXTENSIONS);
  return out;
}

const FILES = sourceFiles();

/** Public methods of a class, in declaration order (accessors and privates excluded). */
function publicMethods(text: string, className: string): string[] {
  const start = text.indexOf(`export class ${className}`);
  assert.ok(start >= 0, `${className} not found`);
  const names: string[] = [];
  for (const line of text.slice(start).split("\n")) {
    // Two-space indent = class body. `private`/`protected`/`static`/`get`/`set`
    // are excluded by the shape of the line, not by a name list.
    const match = /^ {2}([a-z][A-Za-z0-9]*)\(/.exec(line);
    const name = match?.[1];
    if (name && name !== "constructor" && !/^ {2}(private|protected|static|get|set|async)\b/.test(line)) {
      names.push(name);
    }
  }
  return [...new Set(names)];
}

/** Files other than `self` that contain `.name(`. */
function callers(name: string, self: string): string[] {
  const needle = `.${name}(`;
  return FILES.filter((f) => f.path !== self && f.text.includes(needle)).map((f) => f.path);
}

/** Files other than `self` that CALL `name(...)` — for free functions, not methods. */
function functionCallers(name: string, self: string): string[] {
  const needle = `${name}(`;
  return FILES.filter((f) => {
    if (f.path === self) return false;
    let at = f.text.indexOf(needle);
    while (at >= 0) {
      const before = f.text[at - 1];
      // A call, not `foo.name(` and not `somethingName(`.
      if (!before || !/[A-Za-z0-9_.]/.test(before)) return true;
      at = f.text.indexOf(needle, at + 1);
    }
    return false;
  }).map((f) => f.path);
}

// ── 1. MissionObservability mutators must be reachable ──────────────────────

const OBSERVABILITY_FILE = `${SRC}orchestration/observability/MissionObservability.ts`;

/**
 * Read-only members: they answer a question rather than record one, so they are
 * allowed to have no in-tree caller (a UI or adapter may read them). Any NEW
 * member that writes state must not be added here without a producer.
 */
const READ_ONLY = new Set([
  "hasLoop",
  "loopSignals",
  "meaningfulProgress",
  "taskProgress",
  "testProgress",
  "persistenceDiagnostics",
  "listMissionIds",
  "summary",
  "projection",
]);

/**
 * Mutators with no producer yet, with the reason they are excused.
 *
 * `setTaskUnits` / `testCompleted` need test-runner counts (`# pass N`) that
 * nothing in the runtime parses yet — that is §5.2a. `setTaskWeight` needs
 * plan-declared DAG weights; today `computeProgress` derives weights from task
 * kind/role defaults, so there is no declared weight to hand it.
 */
const KNOWN_UNWIRED: Array<{ name: string; reason: string }> = [
  { name: "setTaskUnits", reason: "§5.2a — no test-unit parser exists yet" },
  { name: "setTaskWeight", reason: "no plan-declared weights; progress uses kind/role defaults" },
  { name: "testCompleted", reason: "§5.2a — needs VerifyOutcome test counts, which Verifier does not report" },
];

test("MissionObservability mutators are all reachable from live code", () => {
  const text = readFileSync(OBSERVABILITY_FILE, "utf8");
  const mutators = publicMethods(text, "MissionObservability").filter((name) => !READ_ONLY.has(name));
  assert.ok(mutators.length >= 20, `the scan found ${mutators.length} mutators — the extractor is broken`);

  const unwired = mutators
    .filter((name) => callers(name, OBSERVABILITY_FILE).length === 0)
    .map((name) => ({ name, reason: "unexplained" }));

  assert.deepEqual(
    unwired.map((entry) => entry.name).sort(),
    KNOWN_UNWIRED.map((entry) => entry.name).sort(),
    unwired.length === 0
      ? "every mutator has a producer"
      : `dead mutator(s): ${unwired.map((entry) => entry.name).join(", ")} — wire a producer or record why it stays unwired`,
  );

  for (const entry of KNOWN_UNWIRED) assert.ok(entry.reason.length > 10, `${entry.name} needs a real reason`);
});

// ── 2. Producer modules must be called ──────────────────────────────────────

test("every *Notice.ts producer is called from live code", () => {
  const producers = FILES.filter((f) => /\/orchestration\/[A-Za-z]+Notice\.ts$/.test(f.path));
  assert.ok(producers.length >= 3, "expected the recovery, review/repair and activity producers");

  for (const file of producers) {
    const exported = [...file.text.matchAll(/^export (?:async )?function ([a-zA-Z0-9_]+)/gm)]
      .map((m) => m[1])
      .filter((name): name is string => typeof name === "string");
    assert.ok(exported.length > 0, `${file.path} exports nothing`);
    for (const name of exported) {
      assert.ok(
        functionCallers(name, file.path).length > 0,
        `${name} (in ${file.path.split("/").pop()}) is exported but never called — a dead producer`,
      );
    }
  }
});

// ── 3. Runtime callbacks must be wired by the extension ─────────────────────

test("every runtime observability callback is wired by the extension", () => {
  const runtime = readFileSync(`${SRC}runtime/EngineeringRuntime.ts`, "utf8");
  const optionsStart = runtime.indexOf("export interface EngineeringRuntimeOptions");
  assert.ok(optionsStart >= 0, "EngineeringRuntimeOptions not found");
  const optionsBlock = runtime.slice(optionsStart, runtime.indexOf("\n}", optionsStart));
  const callbacks = [
    ...new Set(
      [...optionsBlock.matchAll(/^ {2}(on[A-Z][A-Za-z0-9]*)\??/gm)]
        .map((m) => m[1])
        .filter((name): name is string => typeof name === "string"),
    ),
  ];
  assert.ok(callbacks.length >= 4, `the scan found ${callbacks.length} callbacks — the extractor is broken`);

  const extension = readFileSync(`${EXTENSIONS}index.ts`, "utf8");
  for (const name of callbacks) {
    assert.ok(extension.includes(name), `${name} is declared on the runtime but never passed by the extension`);
  }
});
