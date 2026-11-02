/**
 * Effect classification: turn a shell command (or script it reaches) into the
 * concrete effects it could have: hosts contacted, paths read/written, remote
 * writes, deploys, destructive operations, opaque execution.
 *
 * Best-effort static analysis. Anything not positively understood becomes an
 * `unknown` or `opaque_exec` effect and the engine fails closed on it. This is
 * defence in depth, not a sandbox: see docs/task-discipline.md for what only the
 * OS sandbox can guarantee (arbitrary compiled code, test suites, interpreters).
 */
import { basename, dirname, join, resolve } from "node:path";
import { resolvePath } from "./pathScope.ts";
import { type SimpleCommand, parseShell } from "./shell.ts";

export type EffectKind =
  | "read"
  | "local_write"
  | "remote_read"
  | "remote_write"
  | "artifact_upload"
  | "git_push"
  | "ci_dispatch"
  | "deploy"
  | "remote_restart"
  | "destructive_operation"
  | "opaque_exec"
  | "container_exec"
  | "privileged"
  | "unknown";

export interface Effect {
  kind: EffectKind;
  command: string;
  detail: string;
  hosts: string[];
  paths: string[];
  /** cwd in force for relative `paths`. */
  cwd: string;
  /** Things that could not be resolved statically (variables, substitutions). */
  unresolved?: string[];
  /** Named git remote whose URL the engine must resolve. */
  gitRemote?: string;
  /** Command basename, set only for `unknown` effects from unclassified commands. */
  name?: string;
}

export interface ClassifyDeps {
  /** Read a small text file (script, Makefile, package.json); undefined when unreadable. */
  readText(path: string): string | undefined;
  home: string;
}

export interface Classification {
  effects: Effect[];
  issues: string[];
}

const MAX_DEPTH = 6;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

const READ_UTILS = new Set(
  "ls cat head tail less more wc grep egrep fgrep rg ag stat file du df diff cmp sort uniq cut tr awk gawk sed jq yq xxd hexdump od strings basename dirname realpath readlink pwd echo printf date which type true false test [ sleep tree column nl tac rev fold paste join comm expand unexpand md5sum shasum sha1sum sha256sum cksum uname whoami id hostname ps top lsof find pgrep nproc free uptime printenv env locale seq yes tput clear stty git-lfs".split(
    " ",
  ),
);
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);
const PROGRAM_FIRST = new Set(["awk", "gawk", "sed", "jq", "yq"]);
const NOOP_BUILTINS = new Set([
  "export",
  "unset",
  "set",
  "alias",
  "unalias",
  "readonly",
  "declare",
  "local",
  "shift",
  "wait",
  "trap",
  "ulimit",
  "umask",
  "return",
  "break",
  "continue",
  "exit",
  "hash",
  "typeset",
  "unsetenv",
  ":",
]);
const LOCAL_WRITE_CMDS = new Set([
  "cp",
  "mv",
  "rm",
  "rmdir",
  "unlink",
  "touch",
  "mkdir",
  "ln",
  "chmod",
  "chown",
  "chgrp",
  "tee",
  "install",
  "truncate",
  "patch",
  "mktemp",
]);
const DESTRUCTIVE_CMDS = new Set([
  "dd",
  "mkfs",
  "shred",
  "wipefs",
  "fdisk",
  "parted",
  "diskutil",
  "kill",
  "pkill",
  "killall",
]);
const NET_PROBE = new Set(["ping", "dig", "nslookup", "host", "traceroute", "mtr", "whois"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "ash"]);
const INTERPRETERS = new Set([
  "python",
  "python3",
  "node",
  "deno",
  "bun",
  "ruby",
  "perl",
  "php",
  "Rscript",
  "julia",
  "lua",
  "tsx",
  "ts-node",
  "npx",
]);
const BUILD_TEST = new Set(
  "pytest py.test tox nox ruff mypy pyright flake8 black isort tsc eslint biome jest vitest mocha ctest cmake ninja javac gcc g++ clang clang++ cc c++ rustc rustfmt go cargo mvn gradle gradlew dotnet swift swiftc clj lein sbt stack ghc ocaml dune make".split(
    " ",
  ),
);
const PKG_MANAGERS = new Set([
  "npm",
  "yarn",
  "pnpm",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "pipx",
  "conda",
  "mamba",
  "brew",
  "apt",
  "apt-get",
  "gem",
  "bundle",
]);
const CLOUD = new Set(
  "aws gcloud az oci doctl fly flyctl heroku vercel netlify wrangler serverless sls cf firebase supabase".split(" "),
);
const READ_VERBS = new Set([
  "describe",
  "list",
  "get",
  "ls",
  "show",
  "view",
  "status",
  "whoami",
  "version",
  "info",
  "logs",
  "plan",
  "diff",
  "validate",
  "history",
  "inspect",
]);
const CI_CLIS = new Set(["woodpecker-cli", "circleci", "glab", "buildkite-agent", "drone"]);
const DB_CLIS = new Set([
  "sqlite3",
  "psql",
  "mysql",
  "mariadb",
  "mongosh",
  "mongo",
  "redis-cli",
  "clickhouse-client",
  "cqlsh",
  "influx",
]);
const SQL_MUTATION =
  /\b(drop|truncate|delete|update|insert|alter|create|grant|revoke|replace|flushall|flushdb|merge|vacuum|reindex)\b/i;
const NETWORK_INDICATOR =
  /\b(socket|requests|urllib|httpx|aiohttp|http\.client|ftplib|smtplib|paramiko|fabric|boto3|botocore|XMLHttpRequest|axios|websocket|grpc|pycurl)\b|\bfetch\s*\(|\bfrom\s+['"]node:(net|http|https|dgram|tls)['"]|require\(\s*['"](node:)?(net|http|https|dgram|tls)['"]\s*\)|\bimport\s+(net|http|https)\b|\bcurl\b|\bwget\b|\bscp\b|\brsync\b|\bsftp\b|\bssh\b/;
const SPAWN_INDICATOR =
  /\b(subprocess|os\.system|os\.popen|Popen|child_process|execSync|spawnSync|spawn\s*\(|exec\s*\(|system\s*\()/;
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/([^\s/'"`?#:@]*@)?(\[[0-9a-f:]+\]|[A-Za-z0-9.-]+)/gi;

export function hostOf(spec: string): string | undefined {
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/\s]*@)?(\[[0-9a-f:]+\]|[A-Za-z0-9._-]+)/i.exec(spec);
  return m?.[1]?.replace(/^\[|\]$/g, "").toLowerCase();
}

export function isLoopback(host: string): boolean {
  return LOOPBACK.has(host) || /^127\./.test(host);
}

function scanText(text: string): { network: boolean; spawn: boolean; hosts: string[]; indicators: string[] } {
  const hosts = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const h = m[2]?.toLowerCase();
    if (h && !isLoopback(h)) hosts.add(h);
  }
  const net = NETWORK_INDICATOR.exec(text);
  const spawn = SPAWN_INDICATOR.exec(text);
  return {
    network: !!net || hosts.size > 0,
    spawn: !!spawn,
    hosts: [...hosts],
    indicators: [net?.[0], spawn?.[0], ...hosts].filter((x): x is string => !!x),
  };
}

interface Ctx {
  deps: ClassifyDeps;
  effects: Effect[];
  issues: string[];
  cwd: string;
  depth: number;
}

const positional = (argv: string[], optsWithArg: Set<string> = new Set()): string[] => {
  const out: string[] = [];
  let endOpts = false;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (!endOpts && a === "--") {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith("-") && a !== "-") {
      if (optsWithArg.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
};

function add(ctx: Ctx, e: Partial<Effect> & { kind: EffectKind; command: string; detail: string }) {
  ctx.effects.push({ hosts: [], paths: [], cwd: ctx.cwd, ...e });
}

function dynamicIn(cmd: SimpleCommand): string[] {
  return cmd.argv.filter((_, i) => cmd.dynamic[i]);
}

export function classifyShell(src: string, deps: ClassifyDeps, cwd: string, depth = 0): Classification {
  const ctx: Ctx = { deps, effects: [], issues: [], cwd, depth };
  runScript(src, ctx);
  return { effects: ctx.effects, issues: ctx.issues };
}

function runScript(src: string, ctx: Ctx) {
  if (ctx.depth > MAX_DEPTH) {
    ctx.issues.push("command nesting too deep to classify");
    add(ctx, { kind: "unknown", command: src.slice(0, 80), detail: "nesting too deep" });
    return;
  }
  const parsed = parseShell(src);
  ctx.issues.push(...parsed.issues);
  if (parsed.issues.length)
    add(ctx, { kind: "unknown", command: src.slice(0, 80), detail: `unparseable: ${parsed.issues[0]}` });
  for (const cmd of parsed.commands) runCommand(cmd, ctx, src);
}

function recurse(text: string, ctx: Ctx) {
  runScript(text, { ...ctx, depth: ctx.depth + 1 } as Ctx);
}

function sub(ctx: Ctx): Ctx {
  return { ...ctx, depth: ctx.depth + 1 };
}

const NETWORK_KINDS = new Set<EffectKind>([
  "remote_read",
  "remote_write",
  "artifact_upload",
  "git_push",
  "ci_dispatch",
  "deploy",
  "remote_restart",
]);

function runCommand(cmd: SimpleCommand, ctx: Ctx, whole: string) {
  const before = ctx.effects.length;
  runCommandInner(cmd, ctx, whole);
  if (cmd.dynamic.some(Boolean) && cmd.argv.length) {
    for (const e of ctx.effects.slice(before)) {
      // a computed word in a network command may be the destination: refuse to guess
      if (NETWORK_KINDS.has(e.kind) && e.command.startsWith(cmd.argv.join(" ").slice(0, 160)) && !e.unresolved)
        e.unresolved = ["host"];
    }
  }
}

function runCommandInner(cmd: SimpleCommand, ctx: Ctx, whole: string) {
  // redirections are writes (or reads) regardless of the command
  for (const r of cmd.redirects) {
    if (/^\d+$|^-$/.test(r.target) && r.op.endsWith("&")) continue;
    if (r.op === "<" || r.op === "<<" || r.op === "<<-") {
      add(ctx, {
        kind: "read",
        command: whole.slice(0, 120),
        detail: "input redirect",
        paths: [r.target],
        unresolved: r.dynamic ? [r.target] : undefined,
      });
    } else {
      add(ctx, {
        kind: "local_write",
        command: whole.slice(0, 120),
        detail: `redirect ${r.op}`,
        paths: [r.target],
        unresolved: r.dynamic ? [r.target] : undefined,
      });
    }
  }
  for (const a of cmd.assigns)
    if (
      /^(LD_PRELOAD|DYLD_INSERT_LIBRARIES|BASH_ENV|ENV|PATH|SSH_AUTH_SOCK|GIT_SSH|GIT_SSH_COMMAND|GIT_PROXY_COMMAND)=/.test(
        a,
      )
    )
      add(ctx, { kind: "unknown", command: whole.slice(0, 120), detail: `environment override ${a.split("=")[0]}` });
  if (cmd.argv.length === 0) return;

  const head = cmd.argv[0]!;
  const name = basename(head);
  const systemBin =
    /^(\/usr\/local\/bin|\/usr\/bin|\/bin|\/usr\/sbin|\/sbin|\/opt\/homebrew\/bin|\/opt\/local\/bin)\/[^/]+$/.test(
      head,
    );
  const full = cmd.argv.join(" ");
  const base = { command: full.slice(0, 160) };

  if (cmd.dynamic[0]) {
    add(ctx, { ...base, kind: "unknown", detail: "command name is computed at runtime" });
    return;
  }

  if (name === "cd" || name === "pushd") {
    const t = cmd.argv[1] ?? "~";
    const r = resolvePath(t, ctx.cwd, ctx.deps.home);
    if (r.ok) ctx.cwd = r.path;
    else add(ctx, { ...base, kind: "unknown", detail: `cd target not resolvable: ${r.reason}` });
    return;
  }
  if (NOOP_BUILTINS.has(name)) return;

  if (name === "sudo" || name === "doas" || name === "su" || name === "pkexec") {
    add(ctx, { ...base, kind: "privileged", detail: `${name} privilege escalation` });
    return;
  }

  // ---- wrappers: classify what they run
  const wrapped = unwrap(name, cmd, ctx);
  if (wrapped === "handled") return;
  if (wrapped) {
    runCommand(wrapped, sub(ctx), whole);
    return;
  }

  if (SHELLS.has(name)) return runShell(cmd, ctx, base);
  if (name === "eval") return recurse(cmd.argv.slice(1).join(" "), ctx);
  if (name === "source" || name === ".") return runScriptFile(cmd.argv[1], ctx, base);
  if (!systemBin && (head.startsWith("./") || head.startsWith("../") || head.includes("/")))
    return runPathExecutable(cmd, ctx, base);

  if (name === "ssh" || name === "mosh") return classifySsh(cmd, ctx, base);
  if (name === "scp" || name === "rsync" || name === "sftp") return classifyCopy(cmd, name, ctx, base);
  if (name === "curl" || name === "wget" || name === "http" || name === "https" || name === "aria2c")
    return classifyHttp(cmd, name, ctx, base);
  if (["nc", "ncat", "netcat", "socat", "telnet", "ftp", "lftp", "tftp", "openssl", "nmap"].includes(name)) {
    const pos = positional(cmd.argv);
    add(ctx, {
      ...base,
      kind: "remote_write",
      detail: `${name} opens a network connection`,
      hosts: pos
        .slice(0, 2)
        .map((p) => hostOf(p) ?? "")
        .filter(Boolean),
      unresolved: pos.length ? undefined : ["host"],
    });
    return;
  }
  if (NET_PROBE.has(name)) {
    const pos = positional(cmd.argv);
    add(ctx, {
      ...base,
      kind: "remote_read",
      detail: `${name} network probe`,
      hosts: pos.map((p) => hostOf(p) ?? "").filter(Boolean),
    });
    return;
  }
  if (name === "git") return classifyGit(cmd, ctx, base);
  if (name === "gh" || CI_CLIS.has(name)) return classifyGh(cmd, name, ctx, base);
  if (name === "docker" || name === "podman" || name === "nerdctl" || name === "docker-compose")
    return classifyContainer(cmd, ctx, base);
  if (
    name === "kubectl" ||
    name === "helm" ||
    name === "terraform" ||
    name === "tofu" ||
    name === "ansible" ||
    name === "ansible-playbook" ||
    name === "pulumi" ||
    name === "cdk" ||
    name === "oc"
  )
    return classifyInfra(cmd, name, ctx, base);
  if (CLOUD.has(name)) return classifyCloud(cmd, name, ctx, base);
  if (
    name === "systemctl" ||
    name === "service" ||
    name === "launchctl" ||
    name === "pm2" ||
    name === "supervisorctl" ||
    name === "rc-service"
  ) {
    const verb = cmd.argv.slice(1).find((a) => !a.startsWith("-")) ?? "";
    if (/^(status|list|show|is-active|is-enabled|cat|print|ls|logs|jlist)$/.test(verb))
      add(ctx, { ...base, kind: "read", detail: `${name} ${verb}` });
    else
      add(ctx, {
        ...base,
        kind: "remote_restart",
        detail: `${name} ${verb || "(service change)"} changes running services`,
      });
    return;
  }
  if (DB_CLIS.has(name)) return classifyDb(cmd, name, ctx, base);
  if (name === "crontab" || name === "at" || name === "batch") {
    add(ctx, { ...base, kind: "remote_restart", detail: `${name} changes scheduled jobs` });
    return;
  }
  if (name === "npm" || name === "yarn" || name === "pnpm" || name === "bun") {
    const r = classifyNodePkg(cmd, name, ctx, base);
    if (r) return;
  }
  if (PKG_MANAGERS.has(name)) return classifyPkg(cmd, name, ctx, base);
  if (
    name === "twine" ||
    (name === "cargo" && cmd.argv[1] === "publish") ||
    (name === "gem" && cmd.argv[1] === "push")
  ) {
    add(ctx, { ...base, kind: "artifact_upload", detail: `${name} publishes a package` });
    return;
  }
  if (name === "find") return classifyFind(cmd, ctx, base);
  if (name === "make" || name === "gmake") return classifyMake(cmd, ctx, base);
  if (name === "sed" || (name === "perl" && cmd.argv.some((a) => /^-[a-z]*i/.test(a)))) {
    if (cmd.argv.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "--in-place" || a.startsWith("--in-place="))) {
      const pos = positional(cmd.argv, new Set(["-e", "-f", "-s"]));
      const files = cmd.argv.includes("-e") ? pos : pos.slice(1);
      add(ctx, {
        ...base,
        kind: "local_write",
        detail: "in-place edit",
        paths: files,
        unresolved: dynamicIn(cmd).length ? dynamicIn(cmd) : undefined,
      });
      return;
    }
  }
  if (INTERPRETERS.has(name) || /^python[0-9.]+$/.test(name)) return classifyInterpreter(cmd, name, ctx, base);
  if (BUILD_TEST.has(name)) {
    add(ctx, {
      ...base,
      kind: "opaque_exec",
      detail: `${name} runs project build/test code (cannot be proven side-effect free statically)`,
    });
    return;
  }
  if (DESTRUCTIVE_CMDS.has(name)) {
    const targets =
      name === "dd" ? cmd.argv.filter((a) => a.startsWith("of=")).map((a) => a.slice(3)) : positional(cmd.argv);
    add(ctx, { ...base, kind: "destructive_operation", detail: `${name} is destructive`, paths: targets });
    return;
  }
  if (LOCAL_WRITE_CMDS.has(name)) {
    let targets = positional(cmd.argv, new Set(["-t", "-m", "-o", "-g", "-S", "-T", "--target-directory"]));
    if (name === "mktemp") targets = [];
    const dynW = new Set(dynamicIn(cmd));
    const badW = targets.filter((p) => dynW.has(p));
    add(ctx, {
      ...base,
      kind: "local_write",
      detail: `${name} modifies files`,
      paths: targets,
      unresolved: badW.length ? badW : undefined,
    });
    if (name === "mktemp") add(ctx, { ...base, kind: "read", detail: "mktemp" });
    return;
  }
  if (READ_UTILS.has(name)) {
    let pos = positional(
      cmd.argv,
      new Set([
        "-n",
        "-c",
        "-m",
        "-A",
        "-B",
        "-C",
        "-d",
        "-t",
        "-g",
        "--max-count",
        "--glob",
        "-e",
        "-f",
        "--regexp",
        "--file",
        "-k",
        "-F",
        "-v",
        "-s",
        "-S",
      ]),
    );
    if (
      (PATTERN_FIRST.has(name) || PROGRAM_FIRST.has(name)) &&
      !cmd.argv.some((a) => a === "-e" || a === "-f" || a === "--regexp" || a === "--file")
    )
      pos = pos.slice(1);
    if (
      name === "echo" ||
      name === "printf" ||
      name === "date" ||
      name === "sleep" ||
      name === "seq" ||
      name === "test" ||
      name === "[" ||
      name === "which" ||
      name === "type" ||
      name === "yes"
    )
      pos = [];
    if (name === "env" || name === "printenv") pos = [];
    if (PROGRAM_FIRST.has(name) && name !== "jq" && name !== "yq") {
      const prog = cmd.argv.slice(1).find((a) => !a.startsWith("-")) ?? "";
      if (/system\s*\(|\|\s*getline|\|\s*"|print[^;]*>|\bw\s+\S|\be\b\s*$|\/e\b/.test(prog))
        add(ctx, { ...base, kind: "unknown", detail: `${name} program can run commands or write files` });
    }
    const dyn = new Set(dynamicIn(cmd));
    const bad = pos.filter((p) => dyn.has(p));
    add(ctx, { ...base, kind: "read", detail: name, paths: pos, unresolved: bad.length ? bad : undefined });
    return;
  }
  add(ctx, { ...base, kind: "unknown", name, detail: `${name} is not a classified command` });
}

function unwrap(name: string, cmd: SimpleCommand, ctx: Ctx): SimpleCommand | "handled" | undefined {
  const a = cmd.argv;
  const rest = (from: number): SimpleCommand | undefined =>
    a.length > from
      ? { argv: a.slice(from), dynamic: cmd.dynamic.slice(from), assigns: [], redirects: [], stdin: cmd.stdin }
      : undefined;
  const skipFlags = (from: number, withArg: string[] = []) => {
    let i = from;
    while (i < a.length && a[i]!.startsWith("-")) {
      i += withArg.includes(a[i]!) ? 2 : 1;
    }
    return i;
  };
  switch (name) {
    case "env": {
      let i = 1;
      while (i < a.length) {
        const w = a[i]!;
        if (w === "-S" || w === "--split-string") {
          recurse(a[i + 1] ?? "", ctx);
          return "handled";
        }
        if (w === "-u" || w === "-C" || w === "--chdir" || w === "--unset") i += 2;
        else if (w.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i++;
        else break;
      }
      return rest(i);
    }
    case "nohup":
    case "command":
    case "builtin":
    case "exec":
    case "setsid":
    case "caffeinate":
    case "unbuffer":
    case "stdbuf":
    case "chrt":
    case "ionice":
    case "time":
      return rest(skipFlags(1, ["-n", "-c", "-p", "-i", "-o", "-e"]));
    case "nice":
      return rest(skipFlags(1, ["-n"]));
    case "timeout": {
      const i = skipFlags(1, ["-s", "-k", "--signal", "--kill-after"]);
      return rest(i + 1);
    }
    case "watch":
      recurse(a.slice(skipFlags(1, ["-n", "-d"])).join(" "), ctx);
      return "handled";
    case "xargs": {
      const i = skipFlags(1, ["-I", "-n", "-P", "-d", "-E", "-L", "-s", "-a", "-R", "-S"]);
      const inner = rest(i);
      if (!inner) {
        add(ctx, { kind: "read", command: "xargs", detail: "xargs echo" });
        return "handled";
      }
      return inner;
    }
    default:
      return undefined;
  }
}

function runShell(cmd: SimpleCommand, ctx: Ctx, base: { command: string }) {
  const a = cmd.argv;
  const ci = a.findIndex((x, i) => i > 0 && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
  if (ci > 0) {
    const script = a[ci + 1];
    if (script === undefined) return add(ctx, { ...base, kind: "unknown", detail: "shell -c without a script" });
    if (cmd.dynamic[ci + 1] && !/^[^$`]*$/.test(script)) {
      // the script text itself is built at runtime; parts we can see are still classified
      add(ctx, { ...base, kind: "unknown", detail: "shell -c script built at runtime" });
    }
    return recurse(script, ctx);
  }
  const file = a.slice(1).find((x) => !x.startsWith("-"));
  if (file) return runScriptFile(file, ctx, base);
  if (cmd.stdin !== undefined) return recurse(cmd.stdin, ctx);
  add(ctx, { ...base, kind: "unknown", detail: "shell reads its script from stdin (e.g. piped from another command)" });
}

function runScriptFile(file: string | undefined, ctx: Ctx, base: { command: string }) {
  if (!file) return add(ctx, { ...base, kind: "unknown", detail: "no script given" });
  const r = resolvePath(file, ctx.cwd, ctx.deps.home);
  if (!r.ok) return add(ctx, { ...base, kind: "unknown", detail: r.reason, unresolved: [file] });
  add(ctx, { ...base, kind: "read", detail: "script file", paths: [r.path] });
  const text = ctx.deps.readText(r.path);
  if (text === undefined)
    return add(ctx, { ...base, kind: "unknown", detail: `script ${file} is unreadable, so its effects are unknown` });
  recurse(text, { ...ctx, cwd: dirname(r.path) } as Ctx);
}

function runPathExecutable(cmd: SimpleCommand, ctx: Ctx, base: { command: string }) {
  const r = resolvePath(cmd.argv[0]!, ctx.cwd, ctx.deps.home);
  if (!r.ok) return add(ctx, { ...base, kind: "unknown", detail: r.reason });
  const text = ctx.deps.readText(r.path);
  if (text?.startsWith("#!")) {
    const shebang = text.split("\n", 1)[0]!;
    if (/\b(ba|z|da|k)?sh\b/.test(shebang)) {
      add(ctx, { ...base, kind: "read", detail: "script file", paths: [r.path] });
      return recurse(text, { ...ctx, cwd: dirname(r.path) } as Ctx);
    }
    const s = scanText(text);
    add(ctx, { ...base, kind: "opaque_exec", detail: `script ${r.path}`, paths: [r.path], hosts: s.hosts });
    if (s.network)
      add(ctx, {
        ...base,
        kind: "remote_write",
        detail: `script contains network use (${s.indicators.slice(0, 3).join(", ")})`,
        hosts: s.hosts,
        unresolved: s.hosts.length ? undefined : ["host"],
      });
    return;
  }
  add(ctx, { ...base, kind: "opaque_exec", detail: `executable ${r.path}`, paths: [r.path] });
}

function sshHostAndCmd(argv: string[]) {
  const withArg = new Set([
    "-b",
    "-c",
    "-D",
    "-E",
    "-e",
    "-F",
    "-I",
    "-i",
    "-J",
    "-L",
    "-l",
    "-m",
    "-O",
    "-o",
    "-p",
    "-Q",
    "-R",
    "-S",
    "-W",
    "-w",
  ]);
  let host: string | undefined;
  let i = 1;
  for (; i < argv.length; i++) {
    const w = argv[i]!;
    if (w.startsWith("-")) {
      if (withArg.has(w)) i++;
      continue;
    }
    host = w;
    i++;
    break;
  }
  return { host, remote: argv.slice(i) };
}

const REMOTE_READ_ONLY = new Set([
  "ls",
  "cat",
  "tail",
  "head",
  "grep",
  "df",
  "du",
  "uptime",
  "ps",
  "journalctl",
  "hostname",
  "uname",
  "whoami",
  "pwd",
  "date",
  "free",
  "stat",
  "wc",
  "id",
  "nproc",
]);

function classifySsh(cmd: SimpleCommand, ctx: Ctx, base: { command: string }) {
  const { host, remote } = sshHostAndCmd(cmd.argv);
  const tunnels = cmd.argv.some((x) => x === "-L" || x === "-R" || x === "-D" || /^-[LRD]./.test(x) || x === "-W");
  const hostName = host ? hostOf(host) : undefined;
  const hosts = hostName ? [hostName] : [];
  const unresolved = hostName ? undefined : ["host"];
  const readOnly = remote.length > 0 && REMOTE_READ_ONLY.has(remote[0]!) && !remote.some((r) => /[;&|><`$()]/.test(r));
  if (!tunnels && readOnly)
    add(ctx, { ...base, kind: "remote_read", detail: `ssh read-only command on ${hostName}`, hosts, unresolved });
  else
    add(ctx, {
      ...base,
      kind: "remote_write",
      detail: tunnels ? "ssh tunnel/forward" : remote.length ? "ssh runs a remote command" : "interactive ssh session",
      hosts,
      unresolved,
    });
}

function classifyCopy(cmd: SimpleCommand, name: string, ctx: Ctx, base: { command: string }) {
  const pos = positional(
    cmd.argv,
    new Set([
      "-e",
      "-i",
      "-P",
      "-p",
      "-o",
      "-F",
      "-J",
      "-c",
      "-l",
      "-S",
      "--rsh",
      "--port",
      "--exclude",
      "--include",
      "-B",
    ]),
  );
  const remotes = pos.filter(
    (p) => /^(?:[^/@:\s]+@)?[^/\s:]+:/.test(p) || /^[a-z]+:\/\//i.test(p) || /^(?:[^/@\s]+@)[^/\s]+$/.test(p),
  );
  const hosts = remotes.map((p) => hostOf(p) ?? "").filter(Boolean);
  const last = pos[pos.length - 1];
  const uploads = last !== undefined && remotes.includes(last);
  const sshOpt = cmd.argv.some((x) => x === "-e" || x === "--rsh" || x.startsWith("--rsh="));
  if (remotes.length === 0 && !sshOpt) {
    add(ctx, {
      ...base,
      kind: name === "sftp" ? "remote_write" : "local_write",
      detail: `${name} between local paths`,
      paths: pos.length ? [pos[pos.length - 1]!] : [],
      unresolved: pos.length ? undefined : ["paths"],
    });
    if (name !== "sftp") add(ctx, { ...base, kind: "read", detail: `${name} sources`, paths: pos.slice(0, -1) });
    return;
  }
  add(ctx, {
    ...base,
    kind: uploads || name === "sftp" ? "artifact_upload" : "remote_read",
    detail:
      uploads || name === "sftp"
        ? `${name} transfers local data to a remote host`
        : `${name} copies from a remote host`,
    hosts,
    unresolved: hosts.length ? undefined : ["host"],
    paths: uploads ? pos.slice(0, -1) : [],
  });
  if (!uploads && last) add(ctx, { ...base, kind: "local_write", detail: `${name} writes local copy`, paths: [last] });
}

function classifyHttp(cmd: SimpleCommand, name: string, ctx: Ctx, base: { command: string }) {
  const a = cmd.argv;
  const urls: string[] = [];
  for (let i = 1; i < a.length; i++) {
    const w = a[i]!;
    const eq = w.startsWith("--url=") ? w.slice(6) : w === "--url" ? a[i + 1] : undefined;
    if (eq) urls.push(eq);
    else if (
      !w.startsWith("-") &&
      (/^[a-z][a-z0-9+.-]*:\/\//i.test(w) ||
        /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}(?:[:/]|$)/.test(w) ||
        LOOPBACK.has(w.split(/[:/]/)[0] ?? ""))
    )
      urls.push(w);
  }
  const hosts = urls.map((u) => hostOf(u) ?? "").filter(Boolean);
  const unresolved = hosts.length ? undefined : ["host"];
  const method = (() => {
    const mi = a.findIndex((x) => x === "-X" || x === "--request" || x === "--method");
    return mi >= 0
      ? (a[mi + 1] ?? "").toUpperCase()
      : a
          .find((x) => /^--(request|method)=/.test(x))
          ?.split("=")[1]
          ?.toUpperCase();
  })();
  const sends =
    a.some(
      (x) =>
        /^(-d|--data(-[a-z]+)?|-F|--form(-string)?|-T|--upload-file|--json|--post-data|--post-file|--body-data|--body-file)(=.*)?$/.test(
          x,
        ) || /^-d./.test(x),
    ) ||
    (method !== undefined && method !== "GET" && method !== "HEAD");
  const hasDynamicUrl = urls.some((u) => /[$`]/.test(u));
  const outIdx = a.findIndex(
    (x) => x === "-o" || x === "-O" || x === "--output" || x === "-P" || x === "--directory-prefix",
  );
  add(ctx, {
    ...base,
    kind: sends ? "remote_write" : "remote_read",
    detail: sends ? `${name} sends data to the remote host` : `${name} request`,
    hosts,
    unresolved: hasDynamicUrl ? ["url"] : unresolved,
  });
  if (outIdx >= 0 && a[outIdx + 1] && a[outIdx + 1] !== "-")
    add(ctx, { ...base, kind: "local_write", detail: `${name} writes output`, paths: [a[outIdx + 1]!] });
  else if (name === "wget" && !a.some((x) => x === "-O" || x === "-q0"))
    add(ctx, { ...base, kind: "local_write", detail: "wget writes a file to cwd", paths: ["."] });
}

const GIT_READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "rev-parse",
  "ls-files",
  "cat-file",
  "describe",
  "shortlog",
  "grep",
  "ls-tree",
  "rev-list",
  "name-rev",
  "show-ref",
  "for-each-ref",
  "merge-base",
  "whatchanged",
  "reflog",
  "count-objects",
  "check-ignore",
  "diff-tree",
  "diff-files",
  "diff-index",
  "var",
  "help",
  "version",
  "difftool",
  "range-diff",
  "bisect",
]);
const GIT_REMOTE_READ = new Set(["fetch", "pull", "clone", "ls-remote", "submodule"]);

function classifyGit(cmd: SimpleCommand, ctx: Ctx, base: { command: string }) {
  const a = cmd.argv;
  let i = 1;
  let cwd = ctx.cwd;
  while (i < a.length && a[i]!.startsWith("-")) {
    if (a[i] === "-C" || a[i] === "-c" || a[i] === "--git-dir" || a[i] === "--work-tree") {
      if (a[i] === "-C" && a[i + 1]) {
        const r = resolvePath(a[i + 1]!, cwd, ctx.deps.home);
        if (r.ok) cwd = r.path;
      }
      if (
        a[i] === "-c" &&
        /^(core\.(sshCommand|gitProxy|fsmonitor|pager|editor|hooksPath)|alias\.|credential\.helper|protocol\.ext)/.test(
          a[i + 1] ?? "",
        )
      )
        add(ctx, { ...base, kind: "unknown", detail: `git -c ${a[i + 1]!.split("=")[0]} can run arbitrary commands` });
      i += 2;
    } else i++;
  }
  const sub0 = a[i] ?? "";
  const args = a.slice(i + 1);
  const c = { ...ctx, cwd };
  if (sub0 === "push") {
    const pos = args.filter((x) => !x.startsWith("-"));
    const remote = pos[0] ?? "origin";
    const url = /^[a-z]+:\/\/|^[^/\s]+@[^/\s]+:/.test(remote);
    add(c, {
      ...base,
      kind: "git_push",
      detail: "git push publishes commits",
      hosts: url ? [hostOf(remote) ?? ""].filter(Boolean) : [],
      gitRemote: url ? undefined : remote,
    });
    return;
  }
  if (GIT_REMOTE_READ.has(sub0)) {
    const pos = args.filter((x) => !x.startsWith("-"));
    const urlArg = pos.find((x) => /^[a-z]+:\/\/|^[^/\s]+@[^/\s]+:/.test(x));
    add(c, {
      ...base,
      kind: "remote_read",
      detail: `git ${sub0} contacts a remote`,
      hosts: urlArg ? [hostOf(urlArg) ?? ""].filter(Boolean) : [],
      gitRemote: urlArg ? undefined : sub0 === "clone" ? undefined : (pos[0] ?? "origin"),
      unresolved: sub0 === "clone" && !urlArg ? ["url"] : undefined,
    });
    add(c, {
      ...base,
      kind: "local_write",
      detail: `git ${sub0} updates the repository`,
      paths: [sub0 === "clone" ? (pos[1] ?? basename((urlArg ?? "repo").replace(/\.git$/, ""))) : "."],
    });
    return;
  }
  if (sub0 === "send-email" || sub0 === "request-pull") {
    add(c, { ...base, kind: "remote_write", detail: `git ${sub0}` });
    return;
  }
  if (
    GIT_READ.has(sub0) ||
    ((sub0 === "branch" || sub0 === "tag" || sub0 === "remote" || sub0 === "config" || sub0 === "stash") &&
      args.every((x) =>
        /^(-v|-vv|-l|--list|--get|--get-all|--show-current|-a|-r|list|show|get-url|--contains|--merged|--no-merged|-n)$|^--format/.test(
          x,
        ),
      ))
  ) {
    add(c, {
      ...base,
      kind: "read",
      detail: `git ${sub0}`,
      paths: args.filter((x) => !x.startsWith("-") && /[/.]/.test(x)),
    });
    return;
  }
  if (sub0 === "") return add(c, { ...base, kind: "read", detail: "git" });
  add(c, { ...base, kind: "local_write", detail: `git ${sub0} modifies the repository`, paths: ["."] });
}

function classifyGh(cmd: SimpleCommand, name: string, ctx: Ctx, base: { command: string }) {
  const a = cmd.argv;
  const words = a.slice(1).filter((x) => !x.startsWith("-"));
  const joined = words.join(" ");
  if (name === "gh" && /^(workflow run|run rerun|run watch)/.test(joined))
    return add(ctx, { ...base, kind: "ci_dispatch", detail: "dispatches a CI workflow", hosts: ["github.com"] });
  if (name !== "gh") return add(ctx, { ...base, kind: "ci_dispatch", detail: `${name} talks to a CI service` });
  if (words[0] === "api") {
    const method = (() => {
      const mi = a.findIndex((x) => x === "-X" || x === "--method");
      return mi >= 0 ? (a[mi + 1] ?? "").toUpperCase() : "GET";
    })();
    const sends = method !== "GET" || a.some((x) => /^(-f|-F|--field|--raw-field|--input)$/.test(x));
    return add(ctx, {
      ...base,
      kind: sends ? "remote_write" : "remote_read",
      detail: `gh api ${method}`,
      hosts: ["github.com"],
    });
  }
  if (
    /^(pr|issue|repo|release|run|workflow|gist|project|label|search|status|browse|auth|config|cache|ruleset)\s+(view|list|status|checks|diff|download|search|show|--help)\b|^(auth status|status|search|--version)/.test(
      joined,
    )
  )
    return add(ctx, { ...base, kind: "remote_read", detail: `gh ${joined}`, hosts: ["github.com"] });
  add(ctx, { ...base, kind: "remote_write", detail: `gh ${joined} changes remote state`, hosts: ["github.com"] });
}

function classifyContainer(cmd: SimpleCommand, ctx: Ctx, base: { command: string }) {
  const sub0 = cmd.argv.slice(1).find((x) => !x.startsWith("-")) ?? "";
  if (/^(ps|images|logs|inspect|info|version|stats|top|history|ls|diff|port|events|search)$/.test(sub0))
    return add(ctx, { ...base, kind: "read", detail: `container ${sub0}` });
  if (sub0 === "push" || sub0 === "login")
    return add(ctx, { ...base, kind: "artifact_upload", detail: `container ${sub0} sends data to a registry` });
  if (sub0 === "pull") return add(ctx, { ...base, kind: "remote_read", detail: "container pull" });
  add(ctx, {
    ...base,
    kind: "container_exec",
    detail: `container ${sub0 || "command"} runs code with its own filesystem and network view`,
  });
}

function classifyInfra(cmd: SimpleCommand, name: string, ctx: Ctx, base: { command: string }) {
  const verb = cmd.argv.slice(1).find((x) => !x.startsWith("-")) ?? "";
  if (
    READ_VERBS.has(verb) ||
    /^(get|describe|logs|top|version|config|api-resources|explain|cluster-info|auth|list|status|template|lint|search|repo|show|fmt|init|validate|output|providers|graph|workspace|--version)$/.test(
      verb,
    )
  )
    return add(ctx, { ...base, kind: "remote_read", detail: `${name} ${verb} (read-only)` });
  add(ctx, { ...base, kind: "deploy", detail: `${name} ${verb || "(change)"} modifies infrastructure` });
}

function classifyCloud(cmd: SimpleCommand, name: string, ctx: Ctx, base: { command: string }) {
  const words = cmd.argv.slice(1).filter((x) => !x.startsWith("-"));
  if (name === "aws" && words[0] === "s3" && /^(cp|sync|mv)$/.test(words[1] ?? ""))
    return add(ctx, {
      ...base,
      kind: /^s3:\/\//.test(words[words.length - 1] ?? "") ? "artifact_upload" : "remote_read",
      detail: `aws s3 ${words[1]}`,
    });
  if (name === "aws" && words[0] === "s3" && /^(rm|rb)$/.test(words[1] ?? ""))
    return add(ctx, { ...base, kind: "destructive_operation", detail: `aws s3 ${words[1]}` });
  if (words.some((w) => READ_VERBS.has(w) || /^(describe|list|get)-/.test(w)))
    return add(ctx, { ...base, kind: "remote_read", detail: `${name} read` });
  add(ctx, { ...base, kind: "deploy", detail: `${name} ${words.slice(0, 2).join(" ")} changes cloud state` });
}

function classifyDb(cmd: SimpleCommand, name: string, ctx: Ctx, base: { command: string }) {
  const a = cmd.argv;
  const hostIdx = a.findIndex((x) => x === "-h" || x === "--host" || x === "--hostname");
  const urlArg = a.find((x) => /^[a-z]+:\/\//.test(x));
  const host =
    hostIdx >= 0
      ? a[hostIdx + 1]
      : (a.find((x) => x.startsWith("--host="))?.split("=")[1] ?? (urlArg ? hostOf(urlArg) : undefined));
  const sqlIdx = a.findIndex(
    (x) => x === "-c" || x === "-e" || x === "--command" || x === "--execute" || x === "--eval",
  );
  const sql = (sqlIdx >= 0 ? a[sqlIdx + 1] : undefined) ?? cmd.stdin ?? a.filter((x) => !x.startsWith("-")).join(" ");
  const remote = !!host && !isLoopback(host);
  if (name === "sqlite3") {
    const pos = positional(a, new Set(["-cmd", "-init", "-separator"]));
    const stmt = pos.slice(1).join(" ") || cmd.stdin || "";
    if (SQL_MUTATION.test(stmt) || (!stmt && !cmd.stdin))
      add(ctx, {
        ...base,
        kind: "destructive_operation",
        detail: "sqlite3 statement may modify or delete data",
        paths: pos.slice(0, 1),
      });
    else add(ctx, { ...base, kind: "read", detail: "sqlite3 query", paths: pos.slice(0, 1) });
    return;
  }
  if (SQL_MUTATION.test(sql) || (sqlIdx < 0 && cmd.stdin === undefined && name !== "redis-cli"))
    add(ctx, {
      ...base,
      kind: "destructive_operation",
      detail: `${name} statement may modify or delete data`,
      hosts: remote && host ? [host.toLowerCase()] : [],
    });
  else
    add(ctx, {
      ...base,
      kind: remote ? "remote_read" : "read",
      detail: `${name} query`,
      hosts: remote && host ? [host.toLowerCase()] : [],
    });
}

function classifyFind(cmd: SimpleCommand, ctx: Ctx, base: { command: string }) {
  const a = cmd.argv;
  const firstExpr = a.findIndex((x, i) => i > 0 && (x.startsWith("-") || x === "(" || x === "!"));
  const paths = a.slice(1, firstExpr < 0 ? a.length : firstExpr);
  const dyn = dynamicIn(cmd);
  add(ctx, {
    ...base,
    kind: "read",
    detail: "find",
    paths: paths.length ? paths : ["."],
    unresolved: dyn.length ? dyn : undefined,
  });
  if (a.includes("-delete"))
    add(ctx, { ...base, kind: "local_write", detail: "find -delete", paths: paths.length ? paths : ["."] });
  if (a.some((x) => /^-(fprint0?|fprintf|fls)$/.test(x)))
    add(ctx, { ...base, kind: "local_write", detail: "find writes a file" });
  for (let i = 1; i < a.length; i++) {
    if (/^-(exec|execdir|ok|okdir)$/.test(a[i]!)) {
      let j = i + 1;
      const inner: string[] = [];
      while (j < a.length && a[j] !== ";" && a[j] !== "+") inner.push(a[j++]!);
      if (inner.length)
        runCommand(
          { argv: inner, dynamic: inner.map(() => false), assigns: [], redirects: [] },
          sub(ctx),
          inner.join(" "),
        );
      i = j;
    }
  }
}

function classifyMake(cmd: SimpleCommand, ctx: Ctx, base: { command: string }) {
  const a = cmd.argv;
  const fi = a.findIndex((x) => x === "-f" || x === "--file" || x === "--makefile");
  const dirIdx = a.findIndex((x) => x === "-C" || x === "--directory");
  const dir =
    dirIdx >= 0 ? resolvePath(a[dirIdx + 1] ?? ".", ctx.cwd, ctx.deps.home) : { ok: true as const, path: ctx.cwd };
  if (!dir.ok) return add(ctx, { ...base, kind: "unknown", detail: dir.reason });
  const mkPath =
    fi >= 0
      ? resolve(dir.path, a[fi + 1] ?? "Makefile")
      : ([join(dir.path, "Makefile"), join(dir.path, "makefile"), join(dir.path, "GNUmakefile")].find(
          (p) => ctx.deps.readText(p) !== undefined,
        ) ?? join(dir.path, "Makefile"));
  const text = ctx.deps.readText(mkPath);
  if (text === undefined)
    return add(ctx, {
      ...base,
      kind: "unknown",
      detail: `Makefile ${mkPath} is unreadable, so target effects are unknown`,
    });
  const targets = a
    .slice(1)
    .filter(
      (x, i, arr) =>
        !x.startsWith("-") && !x.includes("=") && arr[i - 1] !== "-C" && arr[i - 1] !== "-f" && arr[i - 1] !== "-j",
    );
  const want = targets.length ? targets : [firstTarget(text)];
  add(ctx, { ...base, kind: "read", detail: "Makefile", paths: [mkPath] });
  const seen = new Set<string>();
  const visit = (t: string) => {
    if (seen.has(t)) return;
    seen.add(t);
    const rule = recipe(text, t);
    if (!rule) {
      add(ctx, { ...base, kind: "unknown", detail: `make target ${t} not found in ${basename(mkPath)}` });
      return;
    }
    for (const d of rule.deps) visit(d);
    for (const line of rule.lines) {
      if (/^\s*(include|-include|sinclude)\b/.test(line)) continue;
      const resolved = line.replace(/\$\(\$\)/g, "$$").replace(/\$\$/g, "$");
      if (/\$\(|\$\{/.test(line) && /\$[({](?!shell\b)[A-Za-z_]/.test(line.replace(/\$\$/g, "")))
        add(ctx, { ...base, kind: "unknown", detail: `make recipe uses make variables (${line.trim().slice(0, 60)})` });
      runScript(resolved.replace(/^[@+-]+/, ""), { ...ctx, cwd: dir.path, depth: ctx.depth + 1 } as Ctx);
    }
  };
  for (const t of want) visit(t);
}

function firstTarget(text: string): string {
  for (const line of text.split("\n")) {
    const m = /^([A-Za-z0-9_.\-/]+)\s*:(?!=)/.exec(line);
    if (m && !m[1]!.startsWith(".")) return m[1]!;
  }
  return "all";
}

function recipe(text: string, target: string): { deps: string[]; lines: string[] } | undefined {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^\t#=:][^:]*?)\s*:(?!=)\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const names = m[1]!.split(/\s+/);
    if (!names.includes(target)) continue;
    const out: string[] = [];
    let j = i + 1;
    while (j < lines.length && (lines[j]!.startsWith("\t") || lines[j]!.trim() === "")) {
      if (lines[j]!.trim()) out.push(lines[j]!.replace(/^\t/, "").replace(/\\$/, ""));
      j++;
    }
    return { deps: m[2]!.split(/\s+/).filter((d) => d && !d.includes("%") && !d.startsWith("|")), lines: out };
  }
  return undefined;
}

function classifyNodePkg(cmd: SimpleCommand, name: string, ctx: Ctx, base: { command: string }): boolean {
  const a = cmd.argv;
  const verb = a.slice(1).find((x) => !x.startsWith("-")) ?? "";
  if (verb === "publish") {
    add(ctx, { ...base, kind: "artifact_upload", detail: `${name} publish uploads a package` });
    return true;
  }
  const scriptName =
    verb === "run" || verb === "run-script"
      ? a.slice(1).filter((x) => !x.startsWith("-"))[1]
      : /^(test|start|build|lint|dev|t)$/.test(verb)
        ? verb === "t"
          ? "test"
          : verb
        : undefined;
  if (scriptName) {
    const pj = ctx.deps.readText(join(ctx.cwd, "package.json"));
    let script: string | undefined;
    try {
      script = (JSON.parse(pj ?? "{}") as { scripts?: Record<string, string> }).scripts?.[scriptName];
    } catch {
      /* fallthrough: unreadable manifest */
    }
    if (script === undefined) {
      add(ctx, {
        ...base,
        kind: "unknown",
        detail: `package script ${scriptName} not found or package.json unreadable`,
      });
      return true;
    }
    add(ctx, { ...base, kind: "read", detail: "package.json", paths: [join(ctx.cwd, "package.json")] });
    for (const hook of [`pre${scriptName}`, `post${scriptName}`]) {
      try {
        const s = (JSON.parse(pj ?? "{}") as { scripts?: Record<string, string> }).scripts?.[hook];
        if (s) runScript(s, sub(ctx));
      } catch {
        /* ignore */
      }
    }
    runScript(script, sub(ctx));
    return true;
  }
  if (
    /^(install|i|ci|add|update|up|upgrade|remove|rm|uninstall|link|rebuild|dedupe|prune|init|create|exec|dlx|x)$/.test(
      verb,
    )
  ) {
    add(ctx, { ...base, kind: "remote_read", detail: `${name} ${verb} fetches from the package registry` });
    add(ctx, {
      ...base,
      kind: "local_write",
      detail: `${name} ${verb} writes node_modules/lockfile and may run lifecycle scripts`,
      paths: ["."],
    });
    add(ctx, { ...base, kind: "opaque_exec", detail: `${name} ${verb} runs package lifecycle scripts` });
    return true;
  }
  if (
    /^(ls|list|view|info|outdated|audit|why|explain|config|root|prefix|bin|help|version|-v|--version)$/.test(verb) ||
    verb === ""
  ) {
    add(ctx, {
      ...base,
      kind: verb === "view" || verb === "info" || verb === "outdated" || verb === "audit" ? "remote_read" : "read",
      detail: `${name} ${verb}`,
    });
    return true;
  }
  return false;
}

function classifyPkg(cmd: SimpleCommand, name: string, ctx: Ctx, base: { command: string }) {
  const verb = cmd.argv.slice(1).find((x) => !x.startsWith("-")) ?? "";
  if (
    /^(list|show|freeze|check|search|info|config|--version|help|inspect|tree|outdated|cache|debug|-V)$/.test(verb) ||
    verb === ""
  )
    return add(ctx, { ...base, kind: "read", detail: `${name} ${verb}` });
  if (verb === "upload" || verb === "publish")
    return add(ctx, { ...base, kind: "artifact_upload", detail: `${name} ${verb}` });
  add(ctx, { ...base, kind: "remote_read", detail: `${name} ${verb} downloads packages` });
  add(ctx, { ...base, kind: "local_write", detail: `${name} ${verb} modifies the environment`, paths: ["."] });
  add(ctx, { ...base, kind: "opaque_exec", detail: `${name} ${verb} may run install scripts` });
}

function classifyInterpreter(cmd: SimpleCommand, name: string, ctx: Ctx, base: { command: string }) {
  const a = cmd.argv;
  const evalIdx = a.findIndex((x, i) => i > 0 && /^(-c|-e|-p|--eval|--print|-r|-E)$/.test(x));
  let code: string | undefined;
  let scriptPath: string | undefined;
  if (evalIdx > 0 && name !== "npx") code = a[evalIdx + 1];
  else if (cmd.stdin !== undefined && !a.slice(1).some((x) => !x.startsWith("-"))) code = cmd.stdin;
  else if (name === "npx") {
    add(ctx, { ...base, kind: "remote_read", detail: "npx may download and execute a package" });
    return add(ctx, { ...base, kind: "opaque_exec", detail: "npx executes package code" });
  } else {
    const mi = a.findIndex((x) => x === "-m");
    if (mi > 0) {
      const mod = a[mi + 1] ?? "";
      if (
        /^(pytest|unittest|doctest|py_compile|compileall|json\.tool|timeit|trace|cProfile|profile|venv|pip|coverage|mypy|ruff|black|isort|flake8|pylint)$/.test(
          mod,
        )
      ) {
        if (mod === "pip") return classifyPkg({ ...cmd, argv: ["pip", ...a.slice(mi + 2)] }, "pip", ctx, base);
        return add(ctx, { ...base, kind: "opaque_exec", detail: `python -m ${mod} runs project code` });
      }
      return add(ctx, {
        ...base,
        kind: "opaque_exec",
        detail: `python -m ${mod} is not a known test/lint module`,
        unresolved: /^(http\.server|smtpd|ftplib|socketserver|xmlrpc\.server|pydoc)$/.test(mod)
          ? ["network listener"]
          : undefined,
      });
    }
    scriptPath = a.slice(1).find((x) => !x.startsWith("-"));
  }
  if (code !== undefined) {
    const s = scanText(code);
    add(ctx, { ...base, kind: "opaque_exec", detail: `${name} inline code` });
    if (s.network)
      add(ctx, {
        ...base,
        kind: "remote_write",
        detail: `inline code uses network (${s.indicators.slice(0, 3).join(", ")})`,
        hosts: s.hosts,
        unresolved: s.hosts.length ? undefined : ["host"],
      });
    if (s.spawn)
      add(ctx, {
        ...base,
        kind: "unknown",
        detail: `inline code spawns processes (${s.indicators.find((x) => SPAWN_INDICATOR.test(x)) ?? "subprocess"})`,
      });
    if (
      /\bopen\s*\([^)]*['"][wax+]|writeFile|appendFile|\.write_text|\.write_bytes|shutil\.(copy|move|rmtree)|os\.(remove|unlink|rename|makedirs)|unlink|rmSync/.test(
        code,
      )
    )
      add(ctx, { ...base, kind: "local_write", detail: "inline code writes files", unresolved: ["path"] });
    return;
  }
  if (!scriptPath) return add(ctx, { ...base, kind: "opaque_exec", detail: `${name} (interactive/no script)` });
  const r = resolvePath(scriptPath, ctx.cwd, ctx.deps.home);
  if (!r.ok) return add(ctx, { ...base, kind: "unknown", detail: r.reason });
  const text = ctx.deps.readText(r.path);
  add(ctx, { ...base, kind: "read", detail: "script file", paths: [r.path] });
  if (text === undefined)
    return add(ctx, {
      ...base,
      kind: "unknown",
      detail: `script ${scriptPath} is unreadable, so its effects are unknown`,
    });
  const s = scanText(text);
  add(ctx, { ...base, kind: "opaque_exec", detail: `${name} ${scriptPath}`, paths: [r.path] });
  if (s.network)
    add(ctx, {
      ...base,
      kind: "remote_write",
      detail: `script uses network (${s.indicators.slice(0, 3).join(", ")})`,
      hosts: s.hosts,
      unresolved: s.hosts.length ? undefined : ["host"],
    });
  if (s.spawn)
    add(ctx, {
      ...base,
      kind: "unknown",
      detail: `script spawns processes (${s.indicators.find((x) => SPAWN_INDICATOR.test(x)) ?? "subprocess"})`,
    });
}
