/**
 * The pure, dependency-free part of a fork request (T13): the typed parameters Herdr delivers and the identifiers Pi
 * derives from them. Kept apart from forks.ts so the steering parser needs nothing optional (no Git, no GitHub).
 */
import { createHash } from "node:crypto";
import { FULL_SHA } from "../git/forkGit.ts";

/** Typed parameters of a fork or promote request, already validated by `parseForkParams`. */
export interface ForkParams {
  baseSha?: string;
  label?: string;
  expectedHead?: string;
  origin?: string;
  head?: string;
  siblings?: string[];
}

const NODE_ID = /^[A-Za-z0-9._:\-#/]{1,200}$/;
const APPROACH_ID = /^approach:[A-Za-z0-9._\-]{1,128}$/;
const MAX_LABEL = 80;
// C0/C1 controls, bidi overrides/isolates, zero-width, line/paragraph separators
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
const SPOOF = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
export const clean = (v: string, max: number): string =>
  v.replace(SPOOF, " ").replace(/\s+/g, " ").trim().slice(0, max);
const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Strict parse of the `params` object of a fork/promote delivery. Null when it is not exactly the documented shape. */
export function parseForkParams(action: "fork" | "promote", raw: unknown): ForkParams | null {
  if (!isPlain(raw)) return null;
  const allowed = action === "fork" ? ["base_sha", "label", "origin"] : ["expected_head", "origin", "head", "siblings"];
  if (Object.keys(raw).some((k) => !allowed.includes(k))) return null;
  const out: ForkParams = {};
  if (raw.origin !== undefined) {
    if (typeof raw.origin !== "string" || !NODE_ID.test(raw.origin)) return null;
    out.origin = raw.origin;
  }
  if (action === "fork") {
    if (typeof raw.base_sha !== "string" || !FULL_SHA.test(raw.base_sha)) return null;
    out.baseSha = raw.base_sha;
    if (raw.label !== undefined) {
      if (typeof raw.label !== "string") return null;
      out.label = clean(raw.label, MAX_LABEL);
    }
    return out;
  }
  if (typeof raw.expected_head !== "string" || !FULL_SHA.test(raw.expected_head)) return null;
  out.expectedHead = raw.expected_head;
  if (raw.head !== undefined) {
    if (typeof raw.head !== "string" || !FULL_SHA.test(raw.head)) return null;
    out.head = raw.head;
  }
  if (raw.siblings !== undefined) {
    if (!Array.isArray(raw.siblings) || raw.siblings.length > 20) return null;
    if (!raw.siblings.every((s) => typeof s === "string" && APPROACH_ID.test(s))) return null;
    out.siblings = [...new Set(raw.siblings as string[])];
  }
  return out;
}

/** The approach id for a steering request: derived, so a redelivery after a crash finds its own work. */
export function forkIdFor(steeringId: string): string {
  return `fk-${createHash("sha256").update(`pi-fork\0${steeringId}`).digest("hex").slice(0, 16)}`;
}
export const approachNodeId = (approachId: string): string => `approach:${approachId}`;
export const forkBranchFor = (approachId: string): string => `pi-fork/${approachId}`;
