/**
 * What the narrator is told, and what it is allowed to say back. Pure.
 *
 * The Session tab's narrative is the only generated content in the panel, so
 * the cost control lives here rather than in the model call: the narrator is
 * fed **deltas, not transcripts**. Nothing in this file can produce a prompt
 * that grows with the size of the session, the diff, or the conversation.
 *
 * Nothing here reads or writes the ledger. Generated text is not evidence
 * (INV-006), and the shortest way to keep that true is for the narrator to
 * have no path to a ledger at all.
 */

/** One thing that changed since the narrator last spoke. */
export interface NarrativeDelta {
  kind: "work-item" | "phase" | "files" | "commit";
  text: string;
}

/** The observable slice of runtime state the narrator summarises. */
export interface NarrativeInput {
  workItemId?: string;
  goal?: string;
  phase?: string;
  files: string[];
}

/** At most this many newly changed paths are named; the rest are counted. */
const MAX_NAMED_FILES = 5;
/** Hard ceiling on a narrative, so the tab stays a short prose arc. */
const DEFAULT_MAX_CHARS = 400;

/**
 * What changed between two observations.
 *
 * An empty result means "do not ask a model": no change is not worth a call,
 * and this is the check that keeps an idle session free.
 */
export function computeDeltas(previous: NarrativeInput | undefined, current: NarrativeInput): NarrativeDelta[] {
  const deltas: NarrativeDelta[] = [];

  if (current.workItemId && current.workItemId !== previous?.workItemId) {
    deltas.push({
      kind: "work-item",
      text: `started work item ${current.workItemId}${current.goal ? `: ${current.goal}` : ""}`,
    });
  }

  if (current.phase && current.phase !== previous?.phase) {
    deltas.push({ kind: "phase", text: `moved to ${current.phase}` });
  }

  // Only files that are NEW since the last observation. A file already
  // reported is not news, and re-sending the whole set every time is how a
  // delta feed quietly becomes a transcript.
  const seen = new Set(previous?.files ?? []);
  const added = current.files.filter((file) => !seen.has(file));
  if (added.length > 0) {
    const named = added.slice(0, MAX_NAMED_FILES).join(", ");
    const rest = added.length - MAX_NAMED_FILES;
    deltas.push({
      kind: "files",
      text: `changed ${named}${rest > 0 ? ` and ${rest} more` : ""}`,
    });
  }

  return deltas;
}

/** Turn the deltas into the prompt. Bounded by construction. */
export function buildNarrativePrompt(deltas: readonly NarrativeDelta[], previous: string | undefined): string {
  const lines = [
    "You are keeping a one-paragraph running summary of what a coding session has worked on.",
    "Answer with the updated summary only: no preamble, no bullet points, no more than three sentences.",
    "Describe the arc (what we started on, what we moved to, what we are on now).",
    "",
    previous ? `Current summary: ${previous}` : "There is no summary yet.",
    "",
    "Since then:",
    ...deltas.map((d) => `- ${d.text}`),
  ];
  return lines.join("\n");
}

/**
 * Bound and clean a model's answer.
 *
 * Returns undefined for output that cannot be shown, so the caller keeps the
 * previous narrative rather than replacing it with nothing.
 */
export function sanitizeNarrative(raw: string, maxChars: number = DEFAULT_MAX_CHARS): string | undefined {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}
