import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { test } from "node:test";
import { extractWriteTargets } from "../../src/guard/primaryWorktreeGuard.ts";
import { resolveWriteTarget } from "../../src/guard/shellTargets.ts";
import { READ_ONLY_COMMANDS, WRITE_COMMANDS } from "../support/guardCorpus.ts";

const REPO = resolve(process.cwd());
const ENV = { HOME: "/home/tester", PATH: "/usr/bin", USER: "tester" };

/** The guard's own block predicate: a target whose resolution lands in the repo. */
function blocks(command: string): string[] {
  return extractWriteTargets(command, ENV).filter((t) => resolveWriteTarget(t, REPO, ENV).startsWith(`${REPO}/`));
}

test("corpus: no read-only command produces a repository target", () => {
  const offenders = READ_ONLY_COMMANDS.filter((c) => blocks(c).length > 0);
  assert.deepEqual(
    offenders,
    [],
    `these commands write nothing in the repository but still block: ${JSON.stringify(offenders)}`,
  );
});

test("corpus: every write command still produces a repository target", () => {
  const missed = WRITE_COMMANDS.filter((c) => blocks(c).length === 0);
  assert.deepEqual(missed, [], `these writes into the primary checkout are invisible: ${JSON.stringify(missed)}`);
});

test("quoting is data: `>` inside a quoted string is not a redirect", () => {
  // The command that started this: `->` inside "…" was read as `> after"`.
  assert.deepEqual(extractWriteTargets(`echo "before -> after" | tee /dev/null`, ENV), []);
  assert.deepEqual(extractWriteTargets(`grep -rn "x > y" src/`, ENV), []);
  assert.deepEqual(extractWriteTargets(`awk '{ if ($1 > 3) print }' data.csv`, ENV), []);
  // …and the redirect that FOLLOWS the quoted text is still seen.
  assert.deepEqual(extractWriteTargets(`grep -rn "x > y" src/ > hits.txt`, ENV), ["hits.txt"]);
});

test("a quoted program body is data, but a shell's -c script is a command", () => {
  // The `-e` script is data; the redirect AFTER it is real and still recorded —
  // it just resolves outside the repository, so the command is allowed.
  assert.deepEqual(extractWriteTargets(`node -e 'if (a > b) console.log(1)' > /tmp/x 2>/dev/null`, ENV), ["/tmp/x"]);
  assert.deepEqual(blocks(`node -e 'if (a > b) console.log(1)' > /tmp/x 2>/dev/null`), []);
  // `bash -c` executes its argument. Treating it as data would let
  // `bash -c 'echo x > AGENTS.md'` reach the primary checkout untouched.
  assert.deepEqual(extractWriteTargets(`bash -c 'echo x > AGENTS.md'`, ENV), ["AGENTS.md"]);
  assert.deepEqual(extractWriteTargets(`sh -lc 'cat a | tee src/index.ts'`, ENV), ["src/index.ts"]);
});

test("descriptor duplication is not a file write", () => {
  for (const command of ["make 2>&1 | tail -20", "cmd 2>&1", "git show HEAD 2>&1 | head -5", "npm test 2>&1 | tail"]) {
    assert.deepEqual(extractWriteTargets(command, ENV), [], command);
  }
  assert.deepEqual(extractWriteTargets("make 2>&1 > build.log", ENV), ["build.log"]);
});

test("`~` resolves against the home directory, not against the repository", () => {
  // The caller did `isAbsolute ? target : resolve(cwd, target)` and never expanded
  // `~`, so this home-directory backup resolved to a path inside the repo.
  const command = "cp ~/.bashrc ~/.bashrc.bak-1730000000";
  const targets = extractWriteTargets(command, ENV);
  assert.deepEqual(targets, ["/home/tester/.bashrc.bak-1730000000"]);
  assert.deepEqual(blocks(command), []);

  assert.equal(resolveWriteTarget("~/notes.md", REPO, ENV), "/home/tester/notes.md");
  assert.equal(resolveWriteTarget("src/a.ts", REPO, ENV), resolve(REPO, "src/a.ts"));
  assert.equal(resolveWriteTarget("/etc/hosts", REPO, ENV), "/etc/hosts");
  assert.ok(isAbsolute(resolveWriteTarget("a", REPO, ENV)));
});

test("a knowable variable expands; an unknowable one fails closed", () => {
  // HOME is in the environment, so a home-directory write is provably elsewhere.
  assert.deepEqual(blocks(`cp notes.json "$HOME"/notes.json`), []);
  // `$OUT` is not set anywhere: the guard cannot prove the destination is outside
  // the repository, so it must resolve under the cwd and block.
  assert.deepEqual(extractWriteTargets(`echo x > "$OUT"/log.txt`, ENV), ["$OUT/log.txt"]);
  assert.ok(blocks(`echo x > "$OUT"/log.txt`).length === 1);
  // Single quotes are literal in the shell, and literal means the path really is
  // `$HOME/…` under the cwd — so it blocks even though HOME is knowable.
  assert.ok(blocks(`echo x > '$HOME'/log.txt`).length === 1);
  // An assignment inside the command is visible to it.
  assert.deepEqual(extractWriteTargets(`OUT=build/log.txt; echo x > $OUT`, ENV), ["build/log.txt"]);
  assert.deepEqual(extractWriteTargets(`V=$HOME/x.txt; cp a $V`, ENV), ["/home/tester/x.txt"]);
});

test("command substitution is scanned because it really runs", () => {
  assert.deepEqual(extractWriteTargets(`echo $(cat a > src/generated.ts)`, ENV), ["src/generated.ts"]);
  assert.deepEqual(extractWriteTargets(`echo ` + "`cat a > build/out.js`", ENV), ["build/out.js"]);
});

test("copy-family destinations survive quoting and multiple flags", () => {
  assert.deepEqual(extractWriteTargets(`cp -a "old name.ts" "new name.ts"`, ENV), ["new name.ts"]);
  assert.deepEqual(extractWriteTargets(`mv -f a.ts b.ts`, ENV), ["b.ts"]);
  assert.deepEqual(extractWriteTargets(`cat a | tee -a "docs/usage.md"`, ENV), ["docs/usage.md"]);
  assert.deepEqual(extractWriteTargets(`sed -i.bak 's/a/b/' src/f.ts`, ENV), ["src/f.ts"]);
  // `-e` takes the script, so every remaining operand is a file.
  assert.deepEqual(extractWriteTargets(`sed -e 's/a/b/' -i src/f.ts`, ENV), ["src/f.ts"]);
  assert.deepEqual(extractWriteTargets(`sed -i -e 's/a/b/' a.ts b.ts`, ENV), ["a.ts", "b.ts"]);
  assert.deepEqual(extractWriteTargets(`sed 's/a/b/' src/f.ts`, ENV), []); // no -i, no write
});

test("separators inside quotes do not split the command", () => {
  // A raw split on `;` cut this in half and made the next segment start mid-string.
  assert.deepEqual(extractWriteTargets(`echo "a; b" > /tmp/out.log`, ENV), ["/tmp/out.log"]);
  assert.deepEqual(blocks(`echo "a; b" > /tmp/out.log`), []);
  assert.deepEqual(extractWriteTargets(`echo "a; b" > notes.md`, ENV), ["notes.md"]);
  assert.deepEqual(blocks(`echo "a; b" > notes.md`), ["notes.md"]);
});

test("a comment is not a command", () => {
  assert.deepEqual(extractWriteTargets(`echo hi # write > notes.md`, ENV), []);
});

test("heredoc and herestring are input, not output", () => {
  // `<<'EOF'` feeds stdin; the `>` on the same line is a genuine redirect whose
  // target happens to live outside the repository.
  assert.deepEqual(extractWriteTargets(`python - <<'EOF' > /tmp/out.txt 2>&1`, ENV), ["/tmp/out.txt"]);
  assert.deepEqual(blocks(`python - <<'EOF' > /tmp/out.txt 2>&1`), []);
  assert.deepEqual(extractWriteTargets(`diff <(cat a) <(cat b)`, ENV), []);
});
