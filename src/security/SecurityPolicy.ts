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
import { SECRET_RULES, type SecretKind, redactSecrets as redactCanonical } from "../platform/redact.ts";

/** Vocabulary for what a rule recognised; it lives with the canonical rules. */
export type { SecretKind };

/**
 * Kind-labelled view of the canonical rule table in `src/platform/redact.ts`.
 * Kept for callers that report *why* text was sanitized. It used to be a second,
 * narrower pattern set maintained by hand here, which is how nine secret shapes
 * leaked through this module while the platform redactor already caught them;
 * the gap matrix in `test/unit/security-redaction-regression.test.ts` is the
 * proof. There is now exactly one table.
 */
export const SECRET_PATTERNS: Array<{ kind: SecretKind; re: RegExp }> = SECRET_RULES.map((rule) => ({
  kind: rule.kind,
  re: rule.pattern,
}));

export const SECRET_REDACTION = "[REDACTED]";

/**
 * Redact known secrets from a string. Returns the sanitized text.
 *
 * The canonical table always runs. `patterns` ADDS caller-specific shapes on
 * top of it — it can no longer replace the default, so passing a short list can
 * never shrink coverage the way the old default-parameter contract allowed.
 * No caller in this repository passes one.
 */
export function redactSecrets(text: string, patterns?: Array<{ kind: SecretKind; re: RegExp }>): string {
  let out = redactCanonical(text);
  for (const { re } of patterns ?? []) out = out.replace(re, SECRET_REDACTION);
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
