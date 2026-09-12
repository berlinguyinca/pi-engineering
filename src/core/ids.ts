/** Compact, collision-resistant id generation for ledger entities. */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomSuffix(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET.charAt((bytes[i] ?? 0) % ALPHABET.length);
  return out;
}

/** Generate a typed, short, unique id such as `WI-1A2B3C`. */
export function id(prefix: string): string {
  return `${prefix}-${randomSuffix(6)}`;
}

export const newEventId = () => id("evt");
export const newWorkItemId = () => id("WI");
export const newCandidateId = () => id("CAND");
export const newTaskId = () => id("TASK");
export const newEntityId = (kind: string) => id(kind.toUpperCase());
export const newEvidenceId = () => id("EVID");
export const newArtifactId = () => id("ART");
export const newRunId = () => id("RUN");
export const newContextPackageId = () => id("CTX");
