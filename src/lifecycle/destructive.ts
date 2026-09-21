/**
 * Destructive and remote-operation gate (spec §20).
 *
 * The policy goal is capability preservation: SSH, Ansible, deployments, service
 * installation and server lifecycle stay available. They are *classified and
 * gated*, never blanket-disabled. Only the irreversible/destructive subset is
 * escalated to a human, and only at the configured risk threshold.
 */

import { riskRank } from "./classification.ts";
import type { RiskPolicy } from "./policy.ts";
import type { LifecycleRisk, WorkCategory } from "./types.ts";

export interface CommandClassification {
  command: string;
  risk: LifecycleRisk;
  categories: WorkCategory[];
  /** True when the command can cause irreversible loss. */
  irreversible: boolean;
  /** True when the command acts on a remote system. */
  remote: boolean;
  /** Legitimate capability this command represents, used in approval prompts. */
  capability?: string;
  reasons: string[];
}

interface Pattern {
  re: RegExp;
  risk: LifecycleRisk;
  categories: WorkCategory[];
  reason: string;
  irreversible?: boolean;
  remote?: boolean;
  capability?: string;
}

/**
 * Ordered most-specific first: the highest-matching risk wins, and a remote
 * capability marker is attached so approval prompts state the real intent.
 */
const PATTERNS: Pattern[] = [
  // --- CRITICAL: irreversible destruction ---
  {
    re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+\/(\s|$)/,
    risk: "CRITICAL",
    categories: ["destructive"],
    reason: "recursive delete at filesystem root",
    irreversible: true,
  },
  {
    re: /\brm\s+(-[a-z]*[rf][a-z]*\s+)+(~|\$HOME)(\/|$|\s)/,
    risk: "CRITICAL",
    categories: ["destructive"],
    reason: "recursive delete of the home directory",
    irreversible: true,
  },
  {
    re: /\brm\s+(-[a-z]*r[a-z]*\s+)+\.?\/?\S+/i,
    risk: "HIGH",
    categories: ["destructive"],
    reason: "recursive delete of a path",
    irreversible: true,
  },
  {
    re: /\bgit\s+clean\s+(-[a-z]*f[a-z]*\s+)*-[a-z]*f/,
    risk: "CRITICAL",
    categories: ["destructive"],
    reason: "git clean -ff deletes untracked files",
    irreversible: true,
  },
  {
    re: /\b(mkfs|fdisk|wipefs|shred|dd\s+if=)/,
    risk: "CRITICAL",
    categories: ["destructive", "infra"],
    reason: "raw disk operation",
    irreversible: true,
  },
  {
    re: /\bDROP\s+(DATABASE|SCHEMA)\b/i,
    risk: "CRITICAL",
    categories: ["database", "destructive"],
    reason: "drops a database or schema",
    irreversible: true,
  },
  {
    re: /\bDROP\s+TABLE\b/i,
    risk: "CRITICAL",
    categories: ["database", "destructive"],
    reason: "drops a table",
    irreversible: true,
  },
  {
    re: /\bTRUNCATE\b/i,
    risk: "CRITICAL",
    categories: ["database", "destructive"],
    reason: "truncates table data",
    irreversible: true,
  },
  {
    re: /\bDELETE\s+FROM\s+\w+\s*(;|$)/i,
    risk: "HIGH",
    categories: ["database"],
    reason: "unqualified DELETE",
    irreversible: true,
  },
  {
    re: /\bgit\s+push\b[^|;&]*--force(-with-lease)?\b/,
    risk: "CRITICAL",
    categories: ["destructive"],
    reason: "force-push rewrites remote history",
    irreversible: true,
  },
  {
    re: /\bgit\s+reset\s+--hard\b/,
    risk: "HIGH",
    categories: ["destructive"],
    reason: "discards uncommitted work",
    irreversible: true,
  },
  {
    re: /\bterraform\s+destroy\b/,
    risk: "CRITICAL",
    categories: ["infra", "deployment", "destructive"],
    reason: "destroys provisioned infrastructure",
    irreversible: true,
    remote: true,
    capability: "terraform",
  },
  {
    re: /\bkubectl\s+delete\b/,
    risk: "CRITICAL",
    categories: ["infra", "destructive"],
    reason: "deletes cluster resources",
    irreversible: true,
    remote: true,
    capability: "kubectl",
  },
  {
    re: /\bhelm\s+(uninstall|delete)\b/,
    risk: "CRITICAL",
    categories: ["infra", "destructive"],
    reason: "removes a deployed release",
    irreversible: true,
    remote: true,
    capability: "helm",
  },
  {
    re: /\bdocker\s+(system\s+prune|volume\s+rm|volume\s+prune|container\s+rm|rm\s+-v)\b/,
    risk: "HIGH",
    categories: ["infra", "destructive"],
    reason: "removes containers or volumes",
    irreversible: true,
    capability: "docker",
  },
  {
    re: /\bchmod\s+(-R\s+)?(777|000)\b|\bchown\s+-R\b/,
    risk: "HIGH",
    categories: ["security", "destructive"],
    reason: "broad permission change",
  },
  {
    re: /\b(sudo|doas)\b/,
    risk: "HIGH",
    categories: ["infra", "service_management"],
    reason: "elevated privileges",
    capability: "sudo",
  },
  { re: /:\(\)\s*\{.*\};\s*:/, risk: "CRITICAL", categories: ["destructive"], reason: "fork bomb", irreversible: true },
  {
    re: /\bhistory\s+-c\b|\b>\s*~\/\.(bashrc|zshrc|profile)\b/,
    risk: "HIGH",
    categories: ["destructive"],
    reason: "overwrites shell configuration",
    irreversible: true,
  },
  {
    re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba)?sh\b/,
    risk: "CRITICAL",
    categories: ["security", "destructive"],
    reason: "pipes a remote script into a shell",
  },

  // --- HIGH: legitimate remote/administrative capability, gated not disabled ---
  {
    re: /^\s*(ssh|scp|sftp)\b/,
    risk: "HIGH",
    categories: ["remote_administration"],
    reason: "remote shell or transfer",
    remote: true,
    capability: "ssh",
  },
  {
    re: /^\s*rsync\b[^|;&]*\s+\S+:\S*/,
    risk: "HIGH",
    categories: ["remote_administration", "deployment"],
    reason: "file sync to a remote host",
    remote: true,
    capability: "rsync",
  },
  {
    re: /\bansible(-playbook)?\b/,
    risk: "HIGH",
    categories: ["infra", "deployment", "remote_administration"],
    reason: "configuration management across hosts",
    remote: true,
    capability: "ansible",
  },
  {
    re: /\bterraform\s+(apply|plan)\b/,
    risk: "HIGH",
    categories: ["infra", "deployment"],
    reason: "changes real infrastructure",
    remote: true,
    capability: "terraform",
  },
  {
    re: /\bkubectl\b/,
    risk: "HIGH",
    categories: ["infra", "deployment"],
    reason: "operates on a live cluster",
    remote: true,
    capability: "kubectl",
  },
  {
    re: /\b(systemctl|service|launchctl)\b/,
    risk: "HIGH",
    categories: ["service_management", "server_lifecycle"],
    reason: "starts, stops or reloads a service",
    capability: "systemctl",
  },
  {
    re: /\b(dnf|yum|apt(-get)?|apk|brew|pacman)\b.*(install|remove|upgrade)/,
    risk: "HIGH",
    categories: ["service_management", "dependency"],
    reason: "installs or removes system packages",
    capability: "package manager",
  },
  {
    re: /\b(docker|podman)\s+(run|compose\s+up|start|stop|restart)\b/,
    risk: "HIGH",
    categories: ["infra", "server_lifecycle"],
    reason: "runs or restarts containers",
    capability: "docker",
  },
  {
    re: /\bnpm\s+(publish|login)\b|\bpnpm\s+publish\b|\btwine\s+upload\b/,
    risk: "HIGH",
    categories: ["deployment", "dependency"],
    reason: "publishes a package",
    remote: true,
    capability: "npm publish",
  },
  {
    re: /\bgit\s+push\b/,
    risk: "NORMAL",
    categories: ["deployment"],
    reason: "pushes to a remote repository",
    remote: true,
    capability: "git push",
  },
  {
    re: /\b(cloudflared|ngrok|tailscale)\b/,
    risk: "HIGH",
    categories: ["remote_administration", "infra"],
    reason: "exposes a local service over a network tunnel",
    remote: true,
    capability: "tunnel",
  },
  {
    re: /\bshutdown\b|\breboot\b|\bpoweroff\b/,
    risk: "CRITICAL",
    categories: ["server_lifecycle", "destructive"],
    reason: "powers off or restarts the machine",
    irreversible: true,
    capability: "server lifecycle",
  },
  {
    re: /\bkill\s+(-9\s+)?(1|all)\b|\bpkill\s+-9\b/,
    risk: "HIGH",
    categories: ["server_lifecycle", "destructive"],
    reason: "kills processes",
    capability: "process control",
  },
  {
    re: /\bcrontab\b/,
    risk: "HIGH",
    categories: ["service_management"],
    reason: "modifies scheduled jobs",
    capability: "cron",
  },
];

/** Read-only commands that never need gating even when they mention risky words. */
const BENIGN_PREFIX =
  /^\s*(ls|cat|grep|rg|find|head|tail|wc|pwd|which|echo|printf|date|env|git\s+(status|log|diff|show|branch)|systemctl\s+status|journalctl|docker\s+(ps|images|logs|inspect)|kubectl\s+(get|describe|logs)|ansible\s+--version|terraform\s+show)\b/;

export function classifyCommand(command: string, policy?: RiskPolicy): CommandClassification {
  const reasons: string[] = [];
  const categories = new Set<WorkCategory>();
  let risk: LifecycleRisk = "LOW";
  let irreversible = false;
  let remote = false;
  let capability: string | undefined;

  const apply = (p: Pattern) => {
    if (riskRank(p.risk) > riskRank(risk)) risk = p.risk;
    for (const c of p.categories) categories.add(c);
    reasons.push(p.reason);
    irreversible = irreversible || !!p.irreversible;
    remote = remote || !!p.remote;
    capability = p.capability ?? capability;
  };

  if (!BENIGN_PREFIX.test(command)) {
    for (const p of PATTERNS) {
      if (p.re.test(command)) apply(p);
    }
  }

  for (const extra of policy?.command_risk ?? []) {
    try {
      if (new RegExp(extra.pattern).test(command)) {
        if (riskRank(extra.risk) > riskRank(risk)) risk = extra.risk;
        reasons.push(`policy.command_risk pattern ${extra.pattern}`);
      }
    } catch {
      reasons.push(`policy.command_risk pattern ${extra.pattern} is not a valid regular expression`);
    }
  }

  // A capability the operator explicitly preserves is never *disabled*: the
  // recorded capability marker keeps it routable and reviewable instead.
  const preserved = policy?.preserve_capabilities ?? [];
  if (capability && preserved.includes(capability)) {
    reasons.push(`capability "${capability}" is preserved by policy and gated, not disabled`);
  }

  return {
    command,
    risk,
    categories: [...categories],
    irreversible,
    remote,
    capability,
    reasons,
  };
}

export type GateDecision = "allow" | "review_after" | "require_approval";

export interface OperationGateResult {
  decision: GateDecision;
  classification: CommandClassification;
  reason: string;
  /** Risk level at or above which approval is required. */
  threshold: LifecycleRisk;
}

/** Decide what happens *before* execution: run, run-then-review, or ask first. */
export function gateOperation(command: string, policy: RiskPolicy): OperationGateResult {
  const classification = classifyCommand(command, policy);
  const threshold = policy.pre_execution_approval_at;
  if (riskRank(classification.risk) >= riskRank(threshold)) {
    return {
      decision: "require_approval",
      classification,
      reason: `${classification.risk} operation (${classification.reasons[0] ?? "policy match"}) requires approval before execution`,
      threshold,
    };
  }
  if (riskRank(classification.risk) >= riskRank("HIGH")) {
    return {
      decision: "review_after",
      classification,
      reason: `${classification.risk} operation allowed to proceed and routed to specialist review`,
      threshold,
    };
  }
  return {
    decision: "allow",
    classification,
    reason: "routine operation",
    threshold,
  };
}

/** Tools that can mutate the workspace or run commands. */
export const MUTATING_TOOLS = new Set(["write", "edit", "multiedit", "bash", "notebook-edit", "powershell"]);

/** True when a tool call can change state outside the model's own context. */
export function isMutatingTool(name: string): boolean {
  return MUTATING_TOOLS.has(name);
}

/** Extract a shell command from a tool-call argument object, when present. */
export function commandFromToolInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const rec = input as Record<string, unknown>;
  const command = rec.command ?? rec.cmd ?? rec.script;
  return typeof command === "string" && command.trim() ? command : undefined;
}
