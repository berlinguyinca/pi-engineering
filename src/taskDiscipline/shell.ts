/**
 * Conservative POSIX-ish shell splitter used only to *classify* commands.
 *
 * It is not a shell and is not a security boundary: anything it cannot parse
 * with certainty is surfaced in `issues` and callers must fail closed. It splits
 * command chains, pipes, subshells, `$()`/backtick/process substitutions,
 * heredocs and redirections so each simple command can be classified alone.
 */

export interface Redirect {
  op: string;
  target: string;
  dynamic: boolean;
}

export interface SimpleCommand {
  argv: string[];
  /** Parallel to argv: the word contains an unquoted/double-quoted expansion. */
  dynamic: boolean[];
  assigns: string[];
  redirects: Redirect[];
  /** Heredoc / here-string text fed to this command. */
  stdin?: string;
}

export interface ParsedShell {
  commands: SimpleCommand[];
  issues: string[];
}

const MAX_DEPTH = 6;
const SKIP_KEYWORDS = new Set(["then", "else", "elif", "do", "{", "}", "fi", "done", "esac", "time", "!"]);
const DROP_KEYWORDS = new Set(["for", "case", "select", "function", "in"]);
const COND_KEYWORDS = new Set(["if", "while", "until"]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

interface Word {
  text: string;
  dynamic: boolean;
}

export function parseShell(src: string, depth = 0): ParsedShell {
  const out: ParsedShell = { commands: [], issues: [] };
  if (depth > MAX_DEPTH) {
    out.issues.push("shell nesting too deep to classify");
    return out;
  }
  const subs: string[] = [];
  let i = 0;
  let words: Word[] = [];
  let redirects: Redirect[] = [];
  let stdinText: string | undefined;
  let pendingRedirect: { op: string } | null = null;
  let cur: { text: string; dynamic: boolean } | null = null;
  const pendingHeredocDelims: { delim: string; strip: boolean; cmdIndex: number }[] = [];

  const pushWord = () => {
    if (!cur) return;
    const w = cur;
    cur = null;
    if (pendingRedirect) {
      const op = pendingRedirect.op;
      pendingRedirect = null;
      if (op === "<<" || op === "<<-") {
        pendingHeredocDelims.push({ delim: w.text, strip: op === "<<-", cmdIndex: -1 });
        return;
      }
      if (op === "<<<") {
        stdinText = `${stdinText ?? ""}${w.text}\n`;
        return;
      }
      redirects.push({ op, target: w.text, dynamic: w.dynamic });
      return;
    }
    words.push(w);
  };

  const endCommand = () => {
    pushWord();
    pendingRedirect = null;
    let ws = words;
    words = [];
    const rds = redirects;
    redirects = [];
    const hd = stdinText;
    stdinText = undefined;
    // leading keywords / conditions
    while (ws.length && (SKIP_KEYWORDS.has(ws[0]!.text) || COND_KEYWORDS.has(ws[0]!.text))) ws = ws.slice(1);
    if (ws.length && DROP_KEYWORDS.has(ws[0]!.text)) ws = [];
    const assigns: string[] = [];
    while (ws.length && ASSIGN.test(ws[0]!.text)) {
      assigns.push(ws[0]!.text);
      ws = ws.slice(1);
    }
    if (ws.length === 0 && rds.length === 0 && !assigns.length) return;
    const cmd: SimpleCommand = {
      argv: ws.map((w) => w.text),
      dynamic: ws.map((w) => w.dynamic),
      assigns,
      redirects: rds,
    };
    if (hd !== undefined) cmd.stdin = hd;
    out.commands.push(cmd);
    // bind pending heredocs to this command
    for (const h of pendingHeredocDelims) if (h.cmdIndex === -1) h.cmdIndex = out.commands.length - 1;
  };

  const matching = (start: number, open: string, close: string): number => {
    let d = 1;
    let j = start;
    let q: string | null = null;
    while (j < src.length) {
      const ch = src[j]!;
      if (q) {
        if (ch === "\\" && q === '"') j++;
        else if (ch === q) q = null;
      } else if (ch === "'" || ch === '"') q = ch;
      else if (ch === "\\") j++;
      else if (ch === open) d++;
      else if (ch === close && --d === 0) return j;
      j++;
    }
    return -1;
  };

  const readHeredocBodies = () => {
    // i points just after a newline
    for (const h of pendingHeredocDelims.splice(0)) {
      const lines: string[] = [];
      let found = false;
      while (i < src.length) {
        let nl = src.indexOf("\n", i);
        if (nl === -1) nl = src.length;
        const line = src.slice(i, nl);
        i = Math.min(nl + 1, src.length);
        if ((h.strip ? line.replace(/^\t+/, "") : line) === h.delim) {
          found = true;
          break;
        }
        lines.push(h.strip ? line.replace(/^\t+/, "") : line);
      }
      if (!found) out.issues.push("unterminated heredoc");
      const cmd = out.commands[h.cmdIndex];
      if (cmd) cmd.stdin = `${cmd.stdin ?? ""}${lines.join("\n")}\n`;
    }
  };

  const append = (ch: string, dyn = false) => {
    if (!cur) cur = { text: "", dynamic: false };
    cur.text += ch;
    if (dyn) cur.dynamic = true;
  };

  while (i < src.length) {
    const ch = src[i]!;
    if (ch === "\\") {
      if (src[i + 1] === "\n") {
        i += 2;
        continue;
      }
      append(src[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) {
        out.issues.push("unterminated single quote");
        append(src.slice(i + 1));
        i = src.length;
        break;
      }
      if (!cur) cur = { text: "", dynamic: false };
      cur.text += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      if (!cur) cur = { text: "", dynamic: false };
      i++;
      let closed = false;
      while (i < src.length) {
        const c = src[i]!;
        if (c === "\\") {
          const n = src[i + 1] ?? "";
          if ('"$`\\\n'.includes(n)) {
            if (n !== "\n") cur.text += n;
            i += 2;
            continue;
          }
          cur.text += c;
          i++;
          continue;
        }
        if (c === '"') {
          closed = true;
          i++;
          break;
        }
        if (c === "$" && src[i + 1] === "(") {
          const end = matching(i + 2, "(", ")");
          if (end === -1) {
            out.issues.push("unterminated command substitution");
            i = src.length;
            break;
          }
          subs.push(src.slice(i + 2, end));
          cur.text += src.slice(i, end + 1);
          cur.dynamic = true;
          i = end + 1;
          continue;
        }
        if (c === "`") {
          const end = src.indexOf("`", i + 1);
          if (end === -1) {
            out.issues.push("unterminated backtick");
            i = src.length;
            break;
          }
          subs.push(src.slice(i + 1, end));
          cur.text += src.slice(i, end + 1);
          cur.dynamic = true;
          i = end + 1;
          continue;
        }
        if (c === "$") cur.dynamic = true;
        cur.text += c;
        i++;
      }
      if (!closed) out.issues.push("unterminated double quote");
      continue;
    }
    if (ch === "$" && src[i + 1] === "(") {
      const end = matching(i + 2, "(", ")");
      if (end === -1) {
        out.issues.push("unterminated command substitution");
        break;
      }
      subs.push(src.slice(i + 2, end));
      append(src.slice(i, end + 1), true);
      i = end + 1;
      continue;
    }
    if ((ch === "<" || ch === ">") && src[i + 1] === "(") {
      const end = matching(i + 2, "(", ")");
      if (end === -1) {
        out.issues.push("unterminated process substitution");
        break;
      }
      subs.push(src.slice(i + 2, end));
      append(src.slice(i, end + 1), true);
      i = end + 1;
      continue;
    }
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end === -1) {
        out.issues.push("unterminated backtick");
        break;
      }
      subs.push(src.slice(i + 1, end));
      append(src.slice(i, end + 1), true);
      i = end + 1;
      continue;
    }
    if (ch === "$") {
      append(ch, true);
      i++;
      continue;
    }
    if (ch === "#" && !cur) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (ch === " " || ch === "\t") {
      pushWord();
      i++;
      continue;
    }
    if (ch === "\n") {
      endCommand();
      i++;
      readHeredocBodies();
      continue;
    }
    if (ch === ";" || ch === "(" || ch === ")") {
      endCommand();
      i++;
      continue;
    }
    if (ch === "&" || ch === "|") {
      const two = src.slice(i, i + 2);
      if (ch === "&" && src[i + 1] === ">") {
        // &> and &>> redirect both streams
        const op = src.slice(i, i + 3) === "&>>" ? "&>>" : "&>";
        pushWord();
        pendingRedirect = { op };
        i += op.length;
        continue;
      }
      endCommand();
      i += two === "&&" || two === "||" || two === "|&" ? 2 : 1;
      continue;
    }
    if (ch === ">" || ch === "<") {
      // numeric fd prefix belongs to the redirect, not argv
      if (cur && /^\d+$/.test((cur as Word).text)) cur = null;
      else pushWord();
      let op = ch;
      let j = i + 1;
      if (src[j] === ch) {
        op += ch;
        j++;
        if (ch === "<" && src[j] === "<") {
          op += "<";
          j++;
        } else if (ch === "<" && src[j] === "-") {
          op += "-";
          j++;
        }
      } else if (ch === ">" && src[j] === "|") {
        op += "|";
        j++;
      } else if (src[j] === "&") {
        op += "&";
        j++;
      }
      pendingRedirect = { op };
      i = j;
      continue;
    }
    append(ch);
    i++;
  }
  endCommand();
  if (pendingHeredocDelims.length) readHeredocBodies();

  for (const s of subs) {
    const sub = parseShell(s, depth + 1);
    out.commands.push(...sub.commands);
    out.issues.push(...sub.issues);
  }
  return out;
}
