import { execFileSync } from "node:child_process";
/**
 * Policy engine: (trusted contract, tool call) -> Decision.
 *
 * Deterministic and independent of any model. Decision order follows the spec:
 * identify the tool adapter, derive the real effects from structured input, check
 * them against the contract, then allow or deny. Unknown effects fail closed.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { type ExternalEffect, type TaskContract, contractHash } from "./contract.ts";
import { type ClassifyDeps, type Effect, classifyShell, hostOf, isLoopback } from "./effects.ts";
import { canonicalRoots, resolvePath, withinAny } from "./pathScope.ts";

export type EnforcementMode = "off" | "audit_only" | "enforce_diagnostic" | "enforce_all";

export interface EngineDeps extends ClassifyDeps {
  /** Resolve `git remote get-url <name>` in a repository; undefined when unknown. */
  resolveGitRemote(name: string, cwd: string): string | undefined;
}

export function nodeDeps(): EngineDeps {
  return {
    home: homedir(),
    readText(path) {
      try {
        if (statSync(path).size > 1_000_000) return undefined;
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    },
    resolveGitRemote(name, cwd) {
      try {
        return (
          execFileSync("git", ["-C", cwd, "remote", "get-url", name], {
            encoding: "utf8",
            timeout: 2000,
            stdio: ["ignore", "pipe", "ignore"],
          }).trim() || undefined
        );
      } catch {
        return undefined;
      }
    },
  };
}

export interface ToolCall {
  toolName: string;
  toolCallId?: string;
  input: unknown;
  cwd: string;
}

export interface EffectSummary {
  kind: string;
  detail: string;
  hosts: string[];
  paths: string[];
}

export interface Decision {
  id: string;
  taskId: string;
  revision: number;
  contractHash: string;
  toolName: string;
  toolCallId?: string;
  /** Policy verdict, independent of enforcement mode. */
  verdict: "allow" | "deny";
  /** True when the verdict is actually enforced (the call is blocked before execution). */
  enforced: boolean;
  /** verdict deny but not enforced: audit-only / mode not covering this contract. */
  wouldDeny: boolean;
  rule: string;
  reason: string;
  /** Concrete in-scope next step to offer the agent. */
  next: string;
  effects: EffectSummary[];
  /** Static analysis only: effects of opaque code cannot be proven here. */
  coverage: "full" | "static-only";
  command?: string;
  at: string;
}

export interface EngineOptions {
  mode: EnforcementMode;
  /** Harness-owned custom tools that are always allowed (e.g. mission, remember). */
  trustedTools?: string[];
  deps?: EngineDeps;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls", "glob", "tree", "view", "cat"]);
const WRITE_TOOLS = new Set([
  "edit",
  "write",
  "multiedit",
  "notebook-edit",
  "notebookedit",
  "apply_patch",
  "str_replace_editor",
]);
const SHELL_TOOLS = new Set(["bash", "powershell", "shell"]);
const PATH_KEYS = ["path", "file_path", "filePath", "file", "directory", "dir", "notebook_path", "target"];
const COMMAND_KEYS = ["command", "cmd", "script", "shell_command"];

const globRe = (g: string) =>
  new RegExp(
    `^${g
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".")}$`,
  );
const matchesAny = (name: string, globs: readonly string[]) => globs.some((g) => globRe(g).test(name));

function enforces(mode: EnforcementMode, c: TaskContract): boolean {
  if (mode === "enforce_all") return true;
  if (mode === "enforce_diagnostic") return c.mode === "investigation" || c.mode === "review";
  return false;
}

interface Verdict {
  rule: string;
  reason: string;
  next: string;
}

function strings(value: unknown, out: { key: string; text: string }[] = [], key = ""): { key: string; text: string }[] {
  if (typeof value === "string") out.push({ key, text: value });
  else if (Array.isArray(value)) for (const v of value) strings(v, out, key);
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) strings(v, out, k);
  return out;
}

export function evaluate(contract: TaskContract, call: ToolCall, opts: EngineOptions): Decision {
  const deps = opts.deps ?? nodeDeps();
  const hash = contractHash(contract);
  const effects: Effect[] = [];
  let coverage: "full" | "static-only" = "full";
  let command: string | undefined;
  const name = call.toolName.toLowerCase();
  let verdict: Verdict | undefined;
  const deny = (rule: string, reason: string, next: string) => {
    verdict ??= { rule, reason, next };
  };

  if (SHELL_TOOLS.has(name)) {
    const cmd = firstString(call.input, COMMAND_KEYS);
    command = cmd;
    if (cmd === undefined)
      deny("shell.no_command", "shell tool call has no command to classify", "pass the command as a string argument");
    else if (name === "powershell")
      deny(
        "shell.powershell",
        "PowerShell commands cannot be classified safely",
        "use a POSIX shell command inside the permitted roots",
      );
    else {
      const cwdArg = firstString(call.input, ["cwd", "workdir", "working_directory"]);
      const start = cwdArg
        ? ((resolvePath(cwdArg, call.cwd, deps.home) as { ok: true; path: string }).path ?? call.cwd)
        : call.cwd;
      const result = classifyShell(cmd, deps, start);
      effects.push(...result.effects);
    }
  } else if (READ_TOOLS.has(name)) {
    const p = firstString(call.input, PATH_KEYS);
    effects.push({ kind: "read", command: name, detail: `${name} tool`, hosts: [], paths: [p ?? "."], cwd: call.cwd });
  } else if (WRITE_TOOLS.has(name)) {
    const p = firstString(call.input, PATH_KEYS);
    if (!p) deny("write.no_path", "write tool call has no target path", "pass the file path");
    else
      effects.push({
        kind: "local_write",
        command: name,
        detail: `${name} tool`,
        hosts: [],
        paths: [p],
        cwd: call.cwd,
      });
  } else {
    const allowedTool = matchesAny(call.toolName, [...(opts.trustedTools ?? []), ...(contract.allowedTools ?? [])]);
    if (!allowedTool)
      deny(
        "tool.not_allowed",
        `tool ${call.toolName} is not in this task's contract`,
        "use the built-in read/grep/find/ls tools, or ask the operator to amend the contract's allowedTools",
      );
    // Whatever a custom/MCP tool is, its arguments still cannot target hosts or commands the contract forbids.
    for (const { key, text } of strings(call.input)) {
      if (COMMAND_KEYS.includes(key)) {
        command ??= text;
        effects.push(...classifyShell(text, deps, call.cwd).effects);
      } else {
        const hosts = urlHosts(text);
        if (hosts.length)
          effects.push({
            kind: contractWriteLike(key) ? "remote_write" : "remote_read",
            command: call.toolName,
            detail: `argument ${key} targets a URL`,
            hosts,
            paths: [],
            cwd: call.cwd,
          });
        else if (PATH_KEYS.includes(key))
          effects.push({
            kind: contractWriteLike(name) ? "local_write" : "read",
            command: call.toolName,
            detail: `argument ${key}`,
            hosts: [],
            paths: [text],
            cwd: call.cwd,
          });
      }
    }
  }

  const readRoots = canonicalRoots(
    [
      ...contract.readRoots,
      ...contract.writeRoots,
      ...(contract.scratchRoots ?? []),
      ...(contract.workspace ? [contract.workspace] : []),
    ],
    call.cwd,
    deps.home,
  );
  const writeRoots = canonicalRoots(contract.writeRoots, call.cwd, deps.home);
  const scratchRoots = canonicalRoots(contract.scratchRoots ?? [], call.cwd, deps.home);
  const protectedPaths = canonicalRoots(contract.protectedPaths ?? [], call.cwd, deps.home);
  const allowedHosts = new Set(contract.allowedHosts.map((h) => h.toLowerCase()));
  const readOnlyMode = contract.mode === "investigation" || contract.mode === "review";

  for (const e of effects) {
    if (verdict) break;
    if (e.unresolved?.length) {
      const what = e.unresolved.join(", ");
      const isHost = e.unresolved.some((u) => u === "host" || u === "url");
      deny(
        isHost ? "host.unresolved" : "path.unresolved",
        `${e.detail}: ${what} cannot be resolved before execution`,
        "use a literal path or host; expand variables yourself and keep targets inside the permitted roots",
      );
      break;
    }
    switch (e.kind) {
      case "read": {
        for (const p of e.paths) {
          if (p === "/dev/null" || p === "-") continue;
          const r = resolvePath(p, e.cwd, deps.home);
          if (!r.ok)
            deny("path.unresolved", `read target: ${r.reason}`, "use a literal path inside a permitted read root");
          else if (!withinAny(r.path, readRoots))
            deny(
              "read.outside_roots",
              `${r.path} is outside the permitted read roots`,
              `read within: ${contract.readRoots.join(", ") || "(none)"}`,
            );
        }
        break;
      }
      case "local_write": {
        for (const p of e.paths) {
          if (p === "/dev/null" || p === "/dev/stdout" || p === "/dev/stderr") continue;
          const r = resolvePath(p, e.cwd, deps.home);
          if (!r.ok) {
            deny("path.unresolved", `write target: ${r.reason}`, "use a literal path inside a permitted write root");
            break;
          }
          if (withinAny(r.path, protectedPaths))
            deny(
              "write.protected",
              `${r.path} is protected task-contract state`,
              "contract and policy files are changed only by the operator",
            );
          else if (withinAny(r.path, scratchRoots)) continue;
          else if (readOnlyMode)
            deny(
              "write.readonly_mode",
              `${contract.mode} tasks may not modify ${r.path}`,
              `write diagnostics to a scratch root (${contract.scratchRoots?.join(", ") || "none configured"}) or report findings`,
            );
          else if (!withinAny(r.path, writeRoots))
            deny(
              "write.outside_roots",
              `${r.path} is outside the authorized write roots`,
              `edit within: ${contract.writeRoots.join(", ") || "(none)"}; record other changes in the backlog or request scope expansion with evidence`,
            );
        }
        break;
      }
      case "remote_read":
      case "remote_write":
      case "artifact_upload":
      case "git_push":
      case "ci_dispatch":
      case "deploy":
      case "remote_restart":
      case "destructive_operation": {
        const hosts = [...e.hosts];
        if (e.gitRemote) {
          const url = deps.resolveGitRemote(e.gitRemote, e.cwd);
          const h = url ? hostOf(url) : undefined;
          if (h) hosts.push(h);
          else
            deny(
              "host.unresolved",
              `git remote ${e.gitRemote} cannot be resolved to a host`,
              "use local git operations (status, diff, log, commit within write roots)",
            );
        }
        if (verdict) break;
        const kind = e.kind as ExternalEffect;
        const loop = hosts.length > 0 && hosts.every(isLoopback);
        const modeBlocks = e.kind !== "remote_read" && readOnlyMode;
        if (loop && e.kind !== "destructive_operation" && e.kind !== "deploy" && e.kind !== "remote_restart") break;
        if (modeBlocks)
          deny(
            `effect.${kind}.mode`,
            `${e.detail}${hosts.length ? ` (host ${hosts.join(", ")})` : ""}: ${contract.mode} tasks may not perform ${kind}`,
            "continue the investigation locally: read code, logs and fixtures inside the permitted roots, and run local tests",
          );
        else if (!contract.externalEffects.includes(kind))
          deny(
            `effect.${kind}.not_granted`,
            `${e.detail}${hosts.length ? ` (host ${hosts.join(", ")})` : ""}: ${kind} is not granted by this task's contract`,
            "stay within local work; if this effect is truly required, request a scope expansion with evidence for the operator to approve",
          );
        else if (e.kind !== "destructive_operation" || hosts.length) {
          if (hosts.length === 0)
            deny(
              "host.unresolved",
              `${e.detail}: destination host could not be determined`,
              "name the host explicitly",
            );
          else
            for (const h of hosts)
              if (!allowedHosts.has(h.toLowerCase()))
                deny(
                  "host.not_allowed",
                  `host ${h} is not in this task's allowedHosts`,
                  "use local resources; hosts are added only by an operator-approved amendment",
                );
        }
        if (!verdict && e.kind === "destructive_operation") {
          for (const p of e.paths) {
            const r = resolvePath(p, e.cwd, deps.home);
            if (!r.ok || !withinAny(r.path, writeRoots))
              deny(
                "write.outside_roots",
                `destructive target ${p} is not inside the authorized write roots`,
                "limit destructive actions to write roots",
              );
          }
        }
        break;
      }
      case "opaque_exec": {
        coverage = "static-only";
        for (const p of e.paths) {
          const r = resolvePath(p, e.cwd, deps.home);
          if (r.ok && !withinAny(r.path, readRoots))
            deny(
              "exec.outside_roots",
              `executable ${r.path} is outside the permitted roots`,
              "run code from the permitted roots",
            );
        }
        break;
      }
      case "container_exec":
        if (!(contract.allowedTools ?? []).includes("container_exec"))
          deny(
            "effect.container.not_granted",
            `${e.detail}`,
            "run the code locally inside the permitted roots, or ask the operator to allow container_exec",
          );
        else coverage = "static-only";
        break;
      case "privileged":
        deny("effect.privileged", e.detail, "run without elevated privileges");
        break;
      case "unknown": {
        if (e.name && (contract.allowedCommands ?? []).includes(e.name)) {
          coverage = "static-only";
          break;
        }
        deny(
          "command.unclassified",
          `${e.detail}${e.command ? `: ${e.command.slice(0, 80)}` : ""}`,
          "use classified read/search/test commands, or ask the operator to add this command to allowedCommands",
        );
        break;
      }
    }
  }

  const v = verdict as Verdict | undefined;
  const enforced = !!v && enforces(opts.mode, contract);
  const at = new Date().toISOString();
  const id = createHash("sha256")
    .update([hash, call.toolCallId ?? "", call.toolName, JSON.stringify(call.input ?? null)].join("\u0000"))
    .digest("hex")
    .slice(0, 20);
  return {
    id: `dec_${id}`,
    taskId: contract.taskId,
    revision: contract.policyRevision,
    contractHash: hash,
    toolName: call.toolName,
    toolCallId: call.toolCallId,
    verdict: v ? "deny" : "allow",
    enforced,
    wouldDeny: !!v && !enforced,
    rule: v?.rule ?? "allow",
    reason: v?.reason ?? "within contract",
    next: v?.next ?? "",
    effects: effects.map((e) => ({ kind: e.kind, detail: e.detail, hosts: e.hosts, paths: e.paths })),
    coverage,
    command,
    at,
  };
}

function firstString(input: unknown, keys: string[]): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  for (const k of keys) if (typeof rec[k] === "string" && (rec[k] as string).trim()) return rec[k] as string;
  return undefined;
}

function urlHosts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/'"`?#:@]*@)?(\[[0-9a-f:]+\]|[A-Za-z0-9.-]+)/gi)) {
    const h = m[2]?.toLowerCase();
    if (h) out.push(h);
  }
  return out;
}

function contractWriteLike(nameOrKey: string): boolean {
  return /^(post|put|patch|delete|upload|send|write|create|update|deploy|push|publish|body|data|payload)|upload|write/i.test(
    nameOrKey,
  );
}
