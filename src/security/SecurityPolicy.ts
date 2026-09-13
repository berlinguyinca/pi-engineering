/**
 * Security hardening (spec §29, backlog B-111).
 *
 * Three deterministic guardrails that run in-process and do not depend on any
 * external system:
 *
 *   1. Secret handling — redact known secret patterns (API keys, tokens,
 *      credentials) from strings before they enter prompts, logs, or artifacts.
 *   2. Tool policy — an allowlist/denylist over tool names a worker may call.
 *   3. Untrusted-repository-instruction guardrails — detect prompt-injection /
 *      instruction-override markers in repository instructions (e.g. a README
 *      that says "ignore your instructions") and flag them so the runtime can
 *      refuse to follow them.
 */
export type SecretKind = "api_key" | "bearer" | "aws" | "private_key" | "generic";

export const SECRET_PATTERNS: Array<{ kind: SecretKind; re: RegExp }> = [
  { kind: "api_key", re: /(sk-[A-Za-z0-9]{16,}|[A-Za-z0-9_-]{24,}\.eyJ[A-Za-z0-9_-]{10,})/g },
  { kind: "bearer", re: /(Bearer\s+[A-Za-z0-9._~+/=-]{16,})/gi },
  { kind: "aws", re: /(AKIA[0-9A-Z]{16})/g },
  {
    kind: "private_key",
    re: /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g,
  },
  { kind: "generic", re: /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*["']?([^"'\s,;]{6,})/gi },
];

export const SECRET_REDACTION = "[REDACTED]";

/** Redact known secrets from a string. Returns the sanitized text. */
export function redactSecrets(
  text: string,
  patterns: Array<{ kind: SecretKind; re: RegExp }> = SECRET_PATTERNS,
): string {
  let out = text;
  for (const { re } of patterns) out = out.replace(re, SECRET_REDACTION);
  return out;
}

export interface ToolPolicyOptions {
  /** Tool names workers are allowed to call. Empty = allow all. */
  allowlist?: string[];
  /** Tool names workers are never allowed to call. */
  denylist?: string[];
}

export class ToolPolicy {
  private readonly allowlist: Set<string>;
  private readonly denylist: Set<string>;

  constructor(opts: ToolPolicyOptions = {}) {
    this.allowlist = new Set(opts.allowlist ?? []);
    this.denylist = new Set(opts.denylist ?? []);
  }

  /** True when a tool is permitted. Denylist wins; if allowlist is non-empty it must contain the tool. */
  allows(tool: string): boolean {
    if (this.denylist.has(tool)) return false;
    if (this.allowlist.size > 0) return this.allowlist.has(tool);
    return true;
  }

  /** Filter a tool list through the policy. */
  filter(tools: string[]): string[] {
    return tools.filter((t) => this.allows(t));
  }
}

/** Prompt-injection / instruction-override markers to look for in repository instructions. */
export const INJECTION_MARKERS: Array<{ id: string; re: RegExp; severity: "high" | "medium" }> = [
  {
    id: "ignore-instructions",
    re: /ignore\s+(all\s+)?(your|the|prior)\s+(instructions|system\s+prompt)/i,
    severity: "high",
  },
  {
    id: "override-prompt",
    re: /(override|replace|disregard)\s+(your|the)\s+(instructions|prompt|system)/i,
    severity: "high",
  },
  {
    id: "secret-exfiltration",
    re: /(exfiltrat|send\s+(these|the)\s+secrets?|upload\s+credentials?)/i,
    severity: "high",
  },
  {
    id: "hidden-instruction",
    re: /(hidden\s+instruction|do\s+not\s+tell|conceal\s+from\s+the\s+user)/i,
    severity: "medium",
  },
  { id: "markdown-override", re: /<system_prompt>|<user_override>|\[ignore all previous\]/i, severity: "high" },
];

export interface InjectionFinding {
  markerId: string;
  severity: "high" | "medium";
  match: string;
}

/** Scan untrusted repository instructions for prompt-injection markers. */
export function scanUntrustedInstructions(text: string, markers = INJECTION_MARKERS): InjectionFinding[] {
  const out: InjectionFinding[] = [];
  for (const m of markers) {
    const mm = m.re.exec(text);
    if (mm) out.push({ markerId: m.id, severity: m.severity, match: mm[0] });
  }
  return out;
}

export interface GuardrailVerdict {
  /** True when the instruction is safe to follow as-is. */
  pass: boolean;
  findings: InjectionFinding[];
  /** The sanitized/truncated instruction (secrets redacted). */
  sanitized: string;
}

/** Apply the full instruction guardrail: redact secrets + detect injection. */
export function evaluateInstruction(text: string): GuardrailVerdict {
  const sanitized = redactSecrets(text);
  const findings = scanUntrustedInstructions(sanitized);
  const pass = findings.filter((f) => f.severity === "high").length === 0;
  return { pass, findings, sanitized };
}
