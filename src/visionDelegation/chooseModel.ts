import type { ProbeResult } from "../resilience/probe.ts";

export interface VisionModelRef {
  provider: string;
  id: string;
}

export interface VisionModelCandidate extends VisionModelRef {
  input?: string[];
}

export interface ChooseVisionModelDeps {
  models: VisionModelCandidate[];
  preference: string[];
  probeFor: (m: VisionModelRef) => Promise<ProbeResult>;
}

export type ChooseVisionModelResult = VisionModelRef | { none: true; reason: string };

const label = (m: VisionModelRef): string => `${m.provider}/${m.id}`;

async function probeOne(
  probeFor: ChooseVisionModelDeps["probeFor"],
  m: VisionModelRef,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const r = await probeFor({ provider: m.provider, id: m.id });
    if (r.healthy && r.authoritative !== false) return { ok: true };
    if (r.healthy) return { ok: false, reason: "health answer was not authoritative" };
    return { ok: false, reason: r.reason ?? "unhealthy" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `health probe failed: ${msg}` };
  }
}

/**
 * Pick a vision-capable model whose health probe is healthy and authoritative.
 * Preference entries (by id) are tried first, then any other eligible model in
 * `models` order. No silent fallback: when nothing is usable, `reason` names
 * every model and why it was not used.
 */
export async function chooseVisionModel(deps: ChooseVisionModelDeps): Promise<ChooseVisionModelResult> {
  const eligible = deps.models.filter((m) => m.input?.includes("image"));
  const skipped = deps.models
    .filter((m) => !m.input?.includes("image"))
    .map((m) => `${label(m)}: does not accept image input`);

  const ordered: VisionModelCandidate[] = [];
  const seen = new Set<VisionModelCandidate>();
  for (const entry of deps.preference) {
    const id = entry.trim();
    if (!id) continue;
    for (const m of eligible) {
      if (m.id === id && !seen.has(m)) {
        seen.add(m);
        ordered.push(m);
      }
    }
  }
  for (const m of eligible) {
    if (!seen.has(m)) ordered.push(m);
  }

  const failures: string[] = [];
  for (const m of ordered) {
    const res = await probeOne(deps.probeFor, m);
    if (res.ok) return { provider: m.provider, id: m.id };
    failures.push(`${label(m)}: ${res.reason}`);
  }

  const head =
    eligible.length === 0
      ? "No vision model available: no model accepts images."
      : "No vision model available: no image-capable model is healthy.";
  return { none: true, reason: [head, ...failures, ...skipped].join("\n") };
}
