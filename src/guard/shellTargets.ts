import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * Shell-aware write-target extraction for the primary-worktree guard (#456).
 *
 * The guard decides whether a bash command writes inside the primary worktree.
 * To do that it needs the command's WRITE TARGETS, and the previous
 * implementation got them by running four regexes over the RAW command string —
 * before any shell parsing happened. Quoting is therefore read as data, and the
 * failure goes in both directions:
 *
 *   `grep -rn "x > y" src/`   → target `y`        (pattern text read as a redirect)
 *   `echo x > "$OUT"/log.txt` → NO target at all  (the capture class excluded `"`)
 *
 * The second one is the one that matters: a write into the protected worktree
 * routed through a quoted variable was invisible to the guard. Clearing the false
 * positives by widening the regexes would have made that worse, so this module
 * tokenizes the way a shell tokenizes and reads targets off the word list.
 *
 * Two properties are held deliberately:
 *
 * 1. FAIL CLOSED. A word naming a variable this process cannot expand is still
 *    returned, so the caller resolves it under the effective cwd — inside the
 *    repository — and the command blocks. `> "$OUT"/log.txt` blocks;
 *    `> "$HOME"/notes.json` does not, because HOME is knowable. The distinction
 *    is expandability, never "looks like a variable".
 * 2. QUOTED TEXT IS DATA, with two exceptions. `$( … )` bodies are scanned
 *    because a command substitution really runs, and a script handed to a shell
 *    (`bash -c '…'`) is scanned because that is a write wearing a disguise —
 *    without it `bash -c 'echo x > AGENTS.md'` walks straight past the guard.
 */

/** A word after quote removal, plus how it was written. */
interface Word {
  text: string;
  /**
   * True when any byte came from inside quotes or after a backslash. Only a word
   * with `quoted === false` can be an operator: `>` inside `"…"` is prose.
   */
  quoted: boolean;
  /**
   * True when the word contains single-quoted or escaped bytes, which the shell
   * would not expand. `$HOME` inside `'…'` is a literal dollar sign, so the word
   * must not be expanded — and must therefore fail closed.
   */
  literal: boolean;
}

/** Verbs whose `-c` argument is a command the shell really executes. */
const SHELL_VERBS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

/** How many levels of command substitution / `sh -c` we are willing to follow. */
const MAX_NESTING = 4;

/**
 * Split a command into segments at unquoted `&&`, `||`, `|&`, `|`, `;`, newline,
 * and tokenize each segment into words. The raw `String.split` this replaces cut
 * `echo "a; b"` in half, which made the next segment start mid-string.
 */
function splitCommand(command: string): Word[][] {
  const segments: Word[][] = [];
  let current: Word[] = [];
  let buffer = "";
  // Three separate states, because conflating them is what made the first draft
  // leak: `wordQuoted`/`wordLiteral` accumulate for the word being built, while
  // `inDouble` says whether the scan sits inside an open `"…"` run. Clearing only
  // the word flags at a closing quote left every later word looking quoted, so
  // `grep "a > b" src/ > hits.txt` lost its real redirect.
  let wordQuoted = false;
  let wordLiteral = false;
  let inDouble = false;

  const flushWord = () => {
    if (buffer.length > 0) {
      current.push({ text: buffer, quoted: wordQuoted, literal: wordLiteral });
      buffer = "";
      wordQuoted = false;
      wordLiteral = false;
    }
  };
  const flushSegment = () => {
    flushWord();
    if (current.length > 0) segments.push(current);
    current = [];
  };

  let i = 0;
  while (i < command.length) {
    const ch = command[i];

    if (!inDouble) {
      // A `#` at the start of a word comments out the rest of the line.
      if (ch === "#" && (i === 0 || /\s/.test(command[i - 1] ?? ""))) break;

      // Separators only mean something outside quotes.
      const two = command.slice(i, i + 2);
      if (two === "&&" || two === "||" || two === "|&") {
        flushSegment();
        i += 2;
        continue;
      }
      if (ch === "|" || ch === ";" || ch === "\n" || ch === "\r") {
        flushSegment();
        i += 1;
        continue;
      }
      if (ch === " " || ch === "\t") {
        flushWord();
        i += 1;
        continue;
      }
      if (ch === "\\") {
        const next = command[i + 1];
        if (next !== undefined) {
          if (next !== "\n") buffer += next; // `a\ b` is one word; `\>` is data
          wordQuoted = true;
          wordLiteral = true;
          i += 2;
          continue;
        }
      }
      if (ch === "'") {
        const end = command.indexOf("'", i + 1);
        buffer += end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
        wordQuoted = true;
        wordLiteral = true; // single quotes suppress expansion
        i = end === -1 ? command.length : end + 1;
        continue;
      }
      if (ch === '"') {
        inDouble = true;
        wordQuoted = true;
        i += 1;
        continue;
      }
      if (ch === "`") {
        const close = command.indexOf("`", i + 1);
        const body = close === -1 ? command.slice(i + 1) : command.slice(i + 1, close);
        buffer += "`" + body + "`";
        wordQuoted = true;
        i = close === -1 ? command.length : close + 1;
        continue;
      }
      if (ch === "$" && command[i + 1] === "(") {
        // Keep the substitution inside the word: it is unresolvable as a value
        // (so a target containing it fails closed) and its body is scanned apart.
        const close = matchParen(command, i + 1);
        buffer += command.slice(i, close + 1);
        wordQuoted = true;
        i = close + 1;
        continue;
      }
      if (ch === "$" && command[i + 1] === "{") {
        const close = command.indexOf("}", i + 2);
        buffer += close === -1 ? command.slice(i) : command.slice(i, close + 1);
        i = close === -1 ? command.length : close + 1;
        continue;
      }
      if (ch === "(" || ch === "{") {
        // A subshell or brace group: the delimiters are not words, but the body
        // really runs — `(cd x && make > log)` writes `log`.
        const close = matchBracket(command, i);
        current.push(...splitCommand(command.slice(i + 1, close)).flat());
        i = close + 1;
        continue;
      }
      buffer += ch;
      i += 1;
      continue;
    }

    // Inside `"…"`: `\` escapes only these characters, and `$` still expands.
    if (ch === '"') {
      inDouble = false;
      i += 1;
      continue;
    }
    if (ch === "\\") {
      const next = command[i + 1];
      if (next !== undefined) {
        buffer += '"\\$`'.includes(next) ? next : `\\${next}`;
        i += 2;
        continue;
      }
    }
    if (ch === "$" && command[i + 1] === "(") {
      const close = matchParen(command, i + 1);
      buffer += command.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }

  flushSegment();
  return segments;
}

/** Index of the `)` that closes the `(` at `open`. */
function matchParen(input: string, open: number): number {
  let depth = 0;
  for (let i = open; i < input.length; i += 1) {
    if (input[i] === "(") depth += 1;
    else if (input[i] === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return input.length;
}

/** Index of the bracket closing the `(`/`{` at `open`. */
function matchBracket(input: string, open: number): number {
  const opener = input[open];
  let depth = 0;
  for (let i = open; i < input.length; i += 1) {
    const ch = input[i];
    if (ch === "(" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "}") {
      depth -= 1;
      if (depth === 0) return ch === (opener === "(" ? ")" : "}") ? i : i;
    }
  }
  return input.length;
}

/** `NAME=value` assignments the command sets for itself, in order of appearance. */
function inlineAssignments(segments: Word[][], env: NodeJS.ProcessEnv): Map<string, string> {
  const vars = new Map<string, string>();
  const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;
  for (const segment of segments) {
    for (const word of segment) {
      if (word.text === "export") continue;
      const [, name, value] = ASSIGN.exec(word.text) ?? [];
      if (name === undefined || value === undefined || word.literal) continue;
      vars.set(name, value);
    }
  }
  // Multi-pass so `V=$HOME/x` picks up HOME from the ambient environment.
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    for (const [name, value] of vars) {
      const expanded = expandWord(value, vars, env, false);
      if (expanded !== undefined && expanded !== value) {
        vars.set(name, expanded);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return vars;
}

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * Expand `$NAME` and a leading `~`. Returns undefined when the word names a
 * variable this process cannot resolve — the caller must then treat the word as a
 * path under the effective cwd rather than skipping it, which is what keeps the
 * guard fail-closed.
 */
function expandWord(
  text: string,
  vars: Map<string, string>,
  env: NodeJS.ProcessEnv,
  literal: boolean,
): string | undefined {
  let out = text;

  if (!literal && (out === "~" || out.startsWith("~/"))) {
    // `$HOME` wins when the caller's environment defines it, the way bash resolves
    // a leading tilde; `os.homedir()` is the fallback, not the answer.
    out = (env.HOME ?? homedir()) + out.slice(1);
  }

  // A single-quoted `$HOME` is a literal dollar sign: the path it names really is
  // `$HOME/…` under the cwd, so it stays as written and blocks.
  if (literal) return out;

  // Anything carrying a substitution is a command, not a value; it cannot be
  // resolved to a path, so it must fail closed.
  if (out.includes("$(") || out.includes("`")) return undefined;

  for (let pass = 0; pass < 4; pass += 1) {
    let unresolved = false;
    out = out.replace(VAR_REF, (_all, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare ?? "";
      const fromCommand = vars.get(name);
      const value = fromCommand !== undefined ? fromCommand : env[name];
      if (value === undefined) {
        unresolved = true;
        return `$${name}`;
      }
      return value;
    });
    VAR_REF.lastIndex = 0;
    if (unresolved) return undefined;
    if (!VAR_REF.test(out)) break;
    VAR_REF.lastIndex = 0;
  }
  VAR_REF.lastIndex = 0;
  return out;
}

/**
 * A write redirect, as a whole word or with its target attached:
 * `>`, `>>`, `>file`, `2>`, `2>>f`, `&>`, `&>>f`, `>|`.
 */
const REDIRECT_WORD = /^(\d*)(&?>{1,2}\|?)$/;
const REDIRECT_ATTACHED = /^(\d*)(&?>>?)(.+)$/;
/** `2>&1`, `>&2`, `2>&-`, `<&-`: a descriptor moved, no file written. */
const FD_DUP = /^(\d*)[<>]&(-|\d*)$/;
/** `<<EOF`, `<<-EOF`, `<<<x`: input, not output. */
const HEREDOC = /^(\d*)<<-?$/;

/** True when the word is a write redirect; returns the attached target if any. */
function redirectOf(word: Word): { attached?: string } | undefined {
  if (word.quoted) return undefined; // `>` inside quotes is data
  if (FD_DUP.test(word.text) || HEREDOC.test(word.text)) return undefined;
  // Whole word first. `REDIRECT_ATTACHED` can also match `>>` — `>{1,2}` gives
  // back one `>` to feed `(.+)` — which read a bare `>>` as a redirect writing a
  // file named `>`, and lost the real target on the next word.
  if (REDIRECT_WORD.test(word.text)) return {};
  const attached = REDIRECT_ATTACHED.exec(word.text);
  if (attached) return { attached: attached[3] };
  return undefined;
}

function isFlag(text: string): boolean {
  return text.startsWith("-") && text.length > 1;
}

/** The verb of a segment, with any leading path stripped (`/bin/cp` is `cp`). */
function verbOf(segment: Word[]): { verb: string; index: number } | undefined {
  for (const [index, word] of segment.entries()) {
    if (word.quoted || isFlag(word.text) || word.text.includes("=")) continue;
    return { verb: word.text.replace(/^.*\//, ""), index };
  }
  return undefined;
}

/**
 * Destinations of the copy family, read off the word list: `cp`/`mv` take the
 * last operand, `tee` takes every operand, `sed -i` takes everything after the
 * script.
 */
function copyDestinations(segment: Word[]): string[] {
  const head = verbOf(segment);
  if (!head) return [];
  const operands = segment
    .slice(head.index + 1)
    .filter((w) => !isFlag(w.text) && !redirectOf(w) && !w.text.includes("="));

  switch (head.verb) {
    case "tee":
      return operands.map((w) => w.text);
    case "cp":
    case "mv": {
      // `cp a b dir/` moves several sources into one destination directory.
      const last = operands[operands.length - 1];
      return operands.length >= 2 && last ? [last.text] : [];
    }
    case "sed": {
      const inPlace = segment.some((w) => /^-i/.test(w.text) || /^--in-place(=|$)/.test(w.text));
      if (!inPlace) return [];
      // `-e` consumes the next word as a script; without `-e` the first remaining
      // operand is the script. Whatever is left is a file the edit rewrites.
      const files: string[] = [];
      let scriptPending = false;
      let sawExpression = false;
      for (const word of segment.slice(head.index + 1)) {
        if (redirectOf(word)) continue;
        if (word.text === "-e" || word.text === "--regexp-editor") {
          sawExpression = true;
          scriptPending = true;
          continue;
        }
        if (isFlag(word.text)) continue;
        if (scriptPending) {
          scriptPending = false;
          continue;
        }
        files.push(word.text);
      }
      return sawExpression ? files : files.slice(1);
    }
    default:
      return [];
  }
}

/** Embedded command strings that really execute. */
function embeddedCommands(segment: Word[]): string[] {
  const found: string[] = [];
  for (const word of segment) {
    const sub = /\$\(([^()]*)\)/g.exec(word.text);
    if (sub?.[1]) found.push(sub[1]);
    const tick = /`([^`]*)`/g.exec(word.text);
    if (tick?.[1]) found.push(tick[1]);
  }
  const head = verbOf(segment);
  if (head && SHELL_VERBS.has(head.verb)) {
    // `bash -c '…'`, `bash -lc '…'`: the script argument is a command.
    for (const [index, word] of segment.slice(head.index + 1).entries()) {
      if (/^-[a-z]*c[a-z]*$/.test(word.text)) {
        const script = segment[head.index + 1 + index + 1];
        if (script) found.push(script.text);
        break;
      }
    }
  }
  return found;
}

function collect(
  command: string,
  env: NodeJS.ProcessEnv,
  out: string[],
  inherited: Map<string, string>,
  depth: number,
): void {
  if (depth > MAX_NESTING) return;
  const segments = splitCommand(command);
  const vars = inlineAssignments(segments, env);
  for (const [name, value] of inherited) if (!vars.has(name)) vars.set(name, value);

  for (const segment of segments) {
    for (const [index, word] of segment.entries()) {
      const redirect = redirectOf(word);
      if (redirect) {
        const next = segment[index + 1];
        const raw = redirect.attached ?? next?.text;
        if (raw !== undefined) {
          // An attached target came out of the operator word itself, whose quoting
          // is already resolved; a following word keeps its own quoting semantics.
          const literal = redirect.attached !== undefined ? false : (next?.literal ?? false);
          const expanded = expandWord(raw, vars, env, literal);
          out.push(expanded ?? raw); // undefined => fail closed on the raw word
        }
        continue;
      }
    }

    for (const target of copyDestinations(segment)) {
      const expanded = expandWord(target, vars, env, false);
      out.push(expanded ?? target);
    }

    for (const inner of embeddedCommands(segment)) {
      collect(inner, env, out, vars, depth + 1);
    }
  }
}

/**
 * File targets a bash command writes: redirects, `tee`, `sed -i`, `cp`/`mv`
 * destinations — including the ones hidden inside quotes, substitutions and
 * `sh -c` scripts.
 *
 * Every returned string is usable as a path: `~` and resolvable `$NAME` are
 * expanded. A target naming an unresolvable variable is returned verbatim so the
 * caller resolves it against the effective cwd and blocks.
 */
export function extractWriteTargets(command: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  collect(command, env, out, new Map(), 0);
  // `/dev/*` is not a repository path in any arrangement this guard knows about,
  // and listing it made `2>/dev/null` look like a candidate worth resolving.
  return [...new Set(out)].filter((t) => t.length > 0 && !t.startsWith("/dev/"));
}

/**
 * Resolve a write target the way the guard needs it: absolute paths as written,
 * `~` against the home directory, everything else against the effective cwd.
 *
 * The caller used to do `isAbsolute ? target : resolve(cwd, target)`, which never
 * expanded `~`, so `cp ~/.bashrc ~/.bashrc.bak-1730000000` — a home-directory
 * backup that touches nothing in the repository — resolved to a path INSIDE the
 * repository and was blocked.
 */
export function resolveWriteTarget(target: string, cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  // Tilde only. Variables are NOT expanded here: extraction already did that and
  // chose to leave an unexpandable or single-quoted word verbatim, which is the
  // fail-closed signal. Re-expanding at this layer turned `echo x > '$HOME'/log`
  // — a file literally named `$HOME/log` under the cwd — into a home-directory
  // path and let it through.
  let text = target;
  if (text === "~" || text.startsWith("~/")) text = (env.HOME ?? homedir()) + text.slice(1);
  if (isAbsolute(text)) return resolve(text);
  return resolve(cwd, text);
}
