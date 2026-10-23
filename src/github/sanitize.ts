/**
 * Bounding and redaction of UNTRUSTED GitHub text (issue titles, bodies, labels, PR bodies).
 *
 * This text can contain prompt injection, shell metacharacters, bidi tricks and credentials.
 * It is DATA: it is never placed in an argv, a shell string or a command template (the gh
 * client takes only validated refs/numbers), and before it is stored or shown it is
 * stripped of control and invisible characters, secret-redacted and length-bounded.
 */
import { redactSecrets } from "../platform/redact.ts";

export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 8 * 1024;

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const INVISIBLE = /[​-‏‪-‮⁠-⁩﻿]/g;

export interface BoundedText {
  text: string;
  truncated: boolean;
}

export function boundUntrusted(raw: unknown, max: number): BoundedText {
  if (typeof raw !== "string") return { text: "", truncated: false };
  // Bound BEFORE running the redaction regexes so a hostile megabyte body costs O(max).
  const head = raw.length > max * 4 ? raw.slice(0, max * 4) : raw;
  const cleaned = redactSecrets(head.replace(CONTROL, " ").replace(INVISIBLE, ""));
  const truncated = raw.length > head.length || cleaned.length > max;
  return { text: truncated ? `${cleaned.slice(0, Math.max(0, max - 1))}…` : cleaned, truncated };
}

export function boundTitle(raw: unknown): string {
  return boundUntrusted(raw, MAX_TITLE_CHARS).text.replace(/\s+/g, " ").trim();
}

export function boundBody(raw: unknown): BoundedText {
  return boundUntrusted(raw, MAX_BODY_CHARS);
}
