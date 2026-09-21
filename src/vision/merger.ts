/**
 * DesignContractMerger + reference precedence
 * (spec: pi-engineering-vision-payload-management-413-recovery, §§34-35, Phase 3).
 *
 * Pure deterministic logic over plain structured inputs. Combines consistent
 * patterns from DesignObservation[] into a UnifiedDesignContract, detects
 * contradictions via a simple keyword heuristic, and resolves conflicts where
 * an explicit precedence grants a `responsive-authority` reference.
 */
import type { DesignObservation } from "./observation.ts";

export const UNIFIED_CONTRACT_SCHEMA_VERSION = "UnifiedDesignContract/v1";

/** Flexible role string; 'visual-language' | 'feature-detail' | 'responsive-authority' are canonical. */
export interface ReferencePrecedence {
  id: string;
  role: "visual-language" | "feature-detail" | "responsive-authority" | string;
}

export interface ReferenceConflict {
  referenceId: string;
  topic: string;
  detail: string;
}

export interface ContractSection {
  title: string;
  items: string[];
}

export interface UnifiedDesignContract {
  schemaVersion: string;
  title: string;
  sections: ContractSection[];
  conflicts: ReferenceConflict[];
}

/** Topic areas used for conflict detection (heuristic, keyword based). */
export const TOPIC_AREAS = [
  "responsive tablet",
  "responsive desktop",
  "responsive mobile",
  "navigation",
  "components",
  "visualHierarchy",
] as const;

/** Known UI subjects used to pair contradictory statements on the same topic. */
const SUBJECT_KEYWORDS = [
  "sidebar",
  "side bar",
  "navigation",
  "nav",
  "header",
  "footer",
  "content",
  "card",
  "grid",
  "panel",
  "menu",
  "toolbar",
  "breadcrumb",
  "hero",
  "table",
  "list",
  "form",
];

/** Positive/visible family — an item asserts the subject is shown or stays. */
const VISIBLE_FAMILY = [
  "persist",
  "visible",
  "shown",
  "stays",
  "stay",
  "sticky",
  "expanded",
  "open",
  "fixed",
  "static",
  "remains",
  "present",
];

/** Hidden/collapse family — an item asserts the subject is hidden or collapses. */
const HIDDEN_FAMILY = [
  "collaps",
  "hidden",
  "hide",
  "hides",
  "disappear",
  "close",
  "closes",
  "closed",
  "removed",
  "fold",
  "folded",
  "gone",
];

type Family = "visible" | "hidden";

function topicItems(obs: DesignObservation, topic: string): string[] {
  switch (topic) {
    case "responsive tablet":
      return obs.responsiveBehavior.tablet;
    case "responsive desktop":
      return obs.responsiveBehavior.desktop;
    case "responsive mobile":
      return obs.responsiveBehavior.mobile;
    case "navigation":
      return obs.navigation;
    case "components":
      return obs.components;
    case "visualHierarchy":
      return obs.visualHierarchy;
    default:
      return [];
  }
}

function sharedSubject(a: string, b: string): string | null {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  for (const subject of SUBJECT_KEYWORDS) {
    if (lowerA.includes(subject) && lowerB.includes(subject)) return subject;
  }
  return null;
}

function familyOf(item: string): Family | null {
  const lower = item.toLowerCase();
  const visible = VISIBLE_FAMILY.some((k) => lower.includes(k));
  const hidden = HIDDEN_FAMILY.some((k) => lower.includes(k));
  if (visible && !hidden) return "visible";
  if (hidden && !visible) return "hidden";
  return null;
}

interface InternalConflict {
  refA: string;
  refB: string;
  topic: string;
  detail: string;
}

/**
 * Heuristic, deterministic contradiction detection. For each topic area we
 * pair statements from different references that share a known UI subject
 * keyword; when one asserts the subject is visible/persists and the other
 * asserts it is hidden/collapses, a conflict is recorded.
 */
function detectConflictsInternal(observations: DesignObservation[]): InternalConflict[] {
  const conflicts: InternalConflict[] = [];
  for (const topic of TOPIC_AREAS) {
    for (let i = 0; i < observations.length; i++) {
      const a = observations[i] as DesignObservation;
      for (let j = i + 1; j < observations.length; j++) {
        const b = observations[j] as DesignObservation;
        for (const itemA of topicItems(a, topic)) {
          for (const itemB of topicItems(b, topic)) {
            const subject = sharedSubject(itemA, itemB);
            if (!subject) continue;
            const familyA = familyOf(itemA);
            const familyB = familyOf(itemB);
            if (familyA !== null && familyB !== null && familyA !== familyB) {
              conflicts.push({
                refA: a.reference,
                refB: b.reference,
                topic,
                detail:
                  `"${itemA}" [from: ${a.reference}] contradicts "${itemB}" [from: ${b.reference}] ` +
                  `over subject '${subject}' (one asserts visible/persists, the other hidden/collapses)`,
              });
            }
          }
        }
      }
    }
  }
  return conflicts;
}

/** Detect contradictory statements across observations (see detectConflictsInternal). */
export function detectConflicts(observations: DesignObservation[]): ReferenceConflict[] {
  return detectConflictsInternal(observations).map((c) => ({
    referenceId: c.refB,
    topic: c.topic,
    detail: c.detail,
  }));
}

const EMPTY: readonly string[] = [];

function traceabilityItems(observations: DesignObservation[]): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const obs of observations) {
    const reqs = [...obs.components, ...obs.navigation, ...obs.reusablePatterns, ...obs.accessibilityNotes];
    for (const req of reqs) {
      const tagged = `${req} [from: ${obs.reference}]`;
      if (!seen.has(tagged)) {
        seen.add(tagged);
        items.push(tagged);
      }
    }
  }
  return items;
}

/**
 * Combine consistent patterns into contract sections. Items are deduped and
 * provenance-tagged as `[from: <reference>]`. When a responsive topic has been
 * resolved by a `responsive-authority` reference, only that reference's items
 * contribute to the corresponding responsive sections.
 */
function buildSections(observations: DesignObservation[], resolvedTopics: Map<string, string>): ContractSection[] {
  const authorityFor = (obs: DesignObservation, topic: string | null): boolean => {
    if (!topic) return true;
    const authority = resolvedTopics.get(topic);
    return authority === undefined || obs.reference === authority;
  };

  const collect = (
    title: string,
    topic: string | null,
    pick: (obs: DesignObservation) => readonly string[],
  ): ContractSection => {
    const items: string[] = [];
    const seen = new Set<string>();
    for (const obs of observations) {
      if (!authorityFor(obs, topic)) continue;
      for (const raw of pick(obs)) {
        const tagged = `${raw} [from: ${obs.reference}]`;
        if (!seen.has(tagged)) {
          seen.add(tagged);
          items.push(tagged);
        }
      }
    }
    return { title, items };
  };

  const responsiveResolved =
    resolvedTopics.has("responsive tablet") ||
    resolvedTopics.has("responsive desktop") ||
    resolvedTopics.has("responsive mobile");
  // References that govern at least one resolved responsive topic.
  const responsiveAuthorities = new Set(resolvedTopics.values());

  const sections: ContractSection[] = [
    collect("Design Philosophy", null, (o) => (o.summary ? [o.summary] : EMPTY)),
    collect("Application Shell", null, (o) => o.layouts),
    collect("Page Hierarchy", null, (o) => o.visualHierarchy),
    collect("Reusable Components", null, (o) => [...o.components, ...o.reusablePatterns]),
    collect("Information Hierarchy", null, () => EMPTY),
    collect("Visual Tokens", null, () => EMPTY),
    collect("Typography", null, () => EMPTY),
    collect("Spacing", null, () => EMPTY),
    collect("Panel Behavior", null, () => EMPTY),
    collect("Navigation Behavior", null, (o) => o.navigation),
    collect("Responsive Rules", null, (o) => {
      if (responsiveResolved && !responsiveAuthorities.has(o.reference)) return EMPTY;
      return [...o.responsiveBehavior.desktop, ...o.responsiveBehavior.tablet, ...o.responsiveBehavior.mobile];
    }),
    collect("Desktop Rules", "responsive desktop", (o) => o.responsiveBehavior.desktop),
    collect("Tablet Rules", "responsive tablet", (o) => o.responsiveBehavior.tablet),
    collect("Mobile Rules", "responsive mobile", (o) => o.responsiveBehavior.mobile),
    collect("Data Visualization Conventions", null, () => EMPTY),
    collect("Animation Rules", null, () => EMPTY),
    collect("Interaction Rules", null, (o) => o.interactionPatterns),
    collect("Accessibility Requirements", null, (o) => o.accessibilityNotes),
    collect("Implementation Constraints", null, (o) => o.implementationConstraints),
    {
      title: "Reference-to-Feature Traceability",
      items: traceabilityItems(observations),
    },
  ];
  return sections.filter((s) => s.items.length > 0);
}

/**
 * Merge observations into a unified design contract. Conflicts are detected,
 * then resolved where an explicit precedence grants a `responsive-authority`
 * reference for a responsive topic; unresolved conflicts are reported.
 */
export class DesignContractMerger {
  merge(observations: DesignObservation[], precedence: ReferencePrecedence[] = []): UnifiedDesignContract {
    const authorities = new Map<string, ReferencePrecedence>();
    for (const p of precedence) {
      if (p.role === "responsive-authority") authorities.set(p.id, p);
    }

    const internalConflicts = detectConflictsInternal(observations);
    const remaining: ReferenceConflict[] = [];
    const resolvedTopics = new Map<string, string>();
    for (const c of internalConflicts) {
      const authoritative = [c.refA, c.refB].map((ref) => authorities.get(ref)).find((p) => p !== undefined);
      if (authoritative && c.topic.startsWith("responsive")) {
        // The authoritative reference's items win; conflict resolved.
        resolvedTopics.set(c.topic, authoritative.id);
      } else {
        remaining.push({ referenceId: c.refB, topic: c.topic, detail: c.detail });
      }
    }

    return {
      schemaVersion: UNIFIED_CONTRACT_SCHEMA_VERSION,
      title: "Unified Design Contract",
      sections: buildSections(observations, resolvedTopics),
      conflicts: remaining,
    };
  }
}

/** Render a UNIFIED-DESIGN-CONTRACT.md-style document. */
export function renderContractMarkdown(contract: UnifiedDesignContract): string {
  const parts: string[] = [];
  parts.push(`# ${contract.title}`);
  parts.push("");
  for (const section of contract.sections) {
    parts.push(`## ${section.title}`);
    parts.push("");
    for (const item of section.items) {
      parts.push(`- ${item}`);
    }
    parts.push("");
  }
  parts.push("## Conflicts");
  parts.push("");
  if (contract.conflicts.length === 0) {
    parts.push("None.");
  } else {
    for (const c of contract.conflicts) {
      parts.push(`- \`${c.referenceId}\` — **${c.topic}**: ${c.detail}`);
    }
  }
  parts.push("");
  return `${parts.join("\n").trimEnd()}\n`;
}
