/**
 * CAV-01 Change Classification: classify diffs and derive required verification
 * gates. Deterministic — no model judgment. A change touching UI paths derives
 * a browser-verification gate (UI_VERIFICATION contract); a change touching a
 * protected artifact is a hard failure (PROTECTED_ARTIFACTS contract).
 */
import { ProtectedArtifactGuard } from "./guard.ts";

export type ChangeKind = "source" | "test" | "ui" | "visual-reference" | "protected" | "docs" | "config" | "other";

export interface DerivedGate {
  /** e.g. "unit", "integration", "browser", "visual", "typecheck", "lint". */
  type: string;
  required: boolean;
  reason: string;
}

export interface ChangeClassification {
  /** Changed path -> primary kind. */
  byPath: Record<string, ChangeKind>;
  /** Distinct kinds present in the diff. */
  kinds: ChangeKind[];
  /** Derived required verification gates. */
  gates: DerivedGate[];
  /** True if the diff touches a protected artifact (hard failure). */
  touchesProtected: boolean;
  /** Reason when touchesProtected is true. */
  protectedPath: string | null;
}

/** Path classifiers, matched in order; first match wins. */
interface Rule {
  kind: ChangeKind;
  re: RegExp;
}

const RULES: Rule[] = [
  // UI and visual-reference rules must come before generic source/docs.
  { kind: "visual-reference", re: /(^|\/)(golden|reference|screenshots?)(\/|\.)/i },
  {
    kind: "ui",
    re: /(^|\/)(src\/)?(ui|web|frontend|components|pages|app)(\/|\.)|\.(tsx|jsx|css|scss|svelte|vue|html)$/i,
  },
  { kind: "test", re: /(^|\/)(test|tests|__tests__)(\/|\.)|\.test\.(ts|tsx|js|jsx|mjs|cjs)$/i },
  { kind: "docs", re: /^docs\//i },
  { kind: "config", re: /\.(json|yaml|yml|toml|env)$/i },
  { kind: "source", re: /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|rs|go|py|java|kt)$/i },
];

function classifyPath(path: string): ChangeKind {
  for (const rule of RULES) {
    if (rule.re.test(path)) return rule.kind;
  }
  return "other";
}

export class ChangeClassifier {
  private readonly guard: ProtectedArtifactGuard;
  private readonly uiRequiresBrowser: boolean;

  constructor(opts?: { protectedPaths?: string[]; uiRequiresBrowser?: boolean }) {
    this.guard = new ProtectedArtifactGuard(opts?.protectedPaths);
    this.uiRequiresBrowser = opts?.uiRequiresBrowser ?? true;
  }

  classify(changedPaths: string[]): ChangeClassification {
    const byPath: Record<string, ChangeKind> = {};
    const kinds = new Set<ChangeKind>();
    let touchesProtected = false;
    let protectedPath: string | null = null;

    for (const p of changedPaths) {
      const kind = classifyPath(p);
      byPath[p] = kind;
      kinds.add(kind);
      if (this.guard.isProtected(p)) {
        touchesProtected = true;
        protectedPath = p;
      }
    }

    const gates: DerivedGate[] = [];
    if (kinds.has("source") || kinds.has("test") || kinds.has("ui")) {
      gates.push({ type: "unit", required: true, reason: "source/test/UI code changed" });
    }
    if (kinds.has("source")) {
      gates.push({ type: "typecheck", required: true, reason: "source changed" });
    }
    if (kinds.has("ui") && this.uiRequiresBrowser) {
      gates.push({
        type: "browser",
        required: true,
        reason: "UI paths changed => browser verification required (UI_VERIFICATION contract)",
      });
    }
    if (kinds.has("visual-reference")) {
      gates.push({ type: "visual", required: true, reason: "visual reference changed => visual regression required" });
    }
    if (touchesProtected) {
      gates.push({ type: "protected", required: true, reason: `diff touches protected artifact: ${protectedPath}` });
    }

    return { byPath, kinds: [...kinds], gates, touchesProtected, protectedPath };
  }
}
