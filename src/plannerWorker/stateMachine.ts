/**
 * Contract lifecycle state machine (spec §4).
 *
 *   pending → ready → running → reviewing → passed
 *                       │  ▲        │
 *                       ▼  │        ▼
 *                   needs_fix ◄─────┘
 *   blocked: a dependency failed, or the worker reported BLOCKED + evidence
 *            (replanning moves it back to pending).
 *   escalated: the local ladder is exhausted; the escalation model runs it.
 *   passed / failed: terminal.
 */

import type { ContractStatus } from "./types.ts";

const TRANSITIONS: Readonly<Record<ContractStatus, readonly ContractStatus[]>> = {
  pending: ["ready", "blocked", "failed"],
  ready: ["running", "blocked", "failed"],
  running: ["reviewing", "needs_fix", "blocked", "failed", "escalated"],
  reviewing: ["passed", "needs_fix", "blocked", "failed", "escalated"],
  needs_fix: ["running", "escalated", "blocked", "failed"],
  blocked: ["pending", "ready", "failed", "escalated"],
  escalated: ["running", "failed"],
  passed: [],
  failed: [],
};

export function canTransition(from: ContractStatus, to: ContractStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ContractStatus, to: ContractStatus): void {
  if (!canTransition(from, to)) throw new Error(`illegal contract transition ${from} -> ${to}`);
}

export function isTerminal(status: ContractStatus): boolean {
  return TRANSITIONS[status].length === 0;
}
