/**
 * Moving pinned model ids onto aliases.
 *
 * `/model-refresh` configures only aliases, so a pin to a concrete id
 * (`provider/qwen3.8-27b-modality-vision-quant-q8_k_xl`) in Pi's settings or in
 * `engineering.yaml` would dangle the moment that id leaves `models.json`.
 * Refresh therefore rewrites such pins itself, so a preempted or renamed model
 * never needs a hand edit.
 *
 * A stale pin goes to the most specific alias that still covers it:
 * `<family>-<size>-<modality>`, then `<family>-<size>`, then `<family>-<modality>`,
 * then `<family>`. That keeps the intent of the pin (a 27B text pin becomes a
 * 27B text alias when one exists) and only widens it when nothing narrower is
 * served. A pin with no covering alias is reported and left alone.
 *
 * Edits are textual, so YAML comments and JSON layout survive, and every file
 * that changes is backed up first.
 */

import { copyFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factsOf } from "./aliasCatalog.ts";

export interface PinCatalog {
  /** Ids now configured for the provider. */
  ids: ReadonlySet<string>;
  /** Pins are only moved when the provider is configured with aliases. */
  aliasOnly: boolean;
}

export interface PinChange {
  from: string;
  to: string;
  provider: string;
}

export interface PinPlan {
  text: string;
  changes: PinChange[];
  /** Stale pins that no served alias covers; left as written. */
  unresolved: Array<{ provider: string; id: string }>;
}

/** The alias that should replace a stale pinned id, or `undefined` when none covers it. */
export function aliasForPin(stale: string, ids: ReadonlySet<string>): string | undefined {
  const facts = factsOf(stale);
  const candidates: string[] = [];
  if (facts) {
    if (facts.modality) candidates.push(`${facts.family}-${facts.size}-${facts.modality}`);
    candidates.push(`${facts.family}-${facts.size}`);
    if (facts.modality) candidates.push(`${facts.family}-${facts.modality}`);
    candidates.push(facts.family);
  } else {
    // A hand-written short name such as `qwen3.8-flash-next`: the size may be two words.
    const [family, a, b] = stale.split("-");
    if (family && a && b) candidates.push(`${family}-${a}_${b}`);
    if (family && a) candidates.push(`${family}-${a}`);
    if (family) candidates.push(family);
  }
  return candidates.find((c) => c !== stale && ids.has(c));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrite stale `provider/id` pins in `text`, plus a `defaultModel` that pairs
 * with a `defaultProvider` in Pi's settings.
 */
export function planPinMigration(text: string, providers: ReadonlyMap<string, PinCatalog>): PinPlan {
  const changes: PinChange[] = [];
  const unresolved: PinPlan["unresolved"] = [];
  let out = text;
  const note = (provider: string, from: string, to: string | undefined) => {
    if (to) changes.push({ provider, from, to });
    else if (!unresolved.some((u) => u.provider === provider && u.id === from)) unresolved.push({ provider, id: from });
  };

  for (const [provider, catalog] of providers) {
    if (!catalog.aliasOnly) continue;
    // `provider/<id>`: a glob such as `provider/*` has no id characters and never matches.
    const pin = new RegExp(`(?<![A-Za-z0-9._/-])${escapeRe(provider)}/([A-Za-z0-9._-]+)`, "g");
    out = out.replace(pin, (whole, id: string) => {
      if (catalog.ids.has(id)) return whole;
      const to = aliasForPin(id, catalog.ids);
      note(provider, id, to);
      return to ? `${provider}/${to}` : whole;
    });
  }

  // Pi's settings keep the default as two fields.
  const defaultProvider = /"defaultProvider"\s*:\s*"([^"]+)"/.exec(out)?.[1];
  const catalog = defaultProvider ? providers.get(defaultProvider) : undefined;
  if (defaultProvider && catalog?.aliasOnly) {
    out = out.replace(/("defaultModel"\s*:\s*")([^"]+)(")/, (whole, pre: string, id: string, post: string) => {
      if (catalog.ids.has(id)) return whole;
      const to = aliasForPin(id, catalog.ids);
      note(defaultProvider, id, to);
      return to ? `${pre}${to}${post}` : whole;
    });
  }
  return { text: out, changes, unresolved };
}

export interface MigratePinsOptions {
  /** Pi's agent directory (holds `settings.json` and `engineering.yaml`). */
  agentDir: string;
  /** Extra policy files, e.g. a repository's `.pi/engineering.yaml`. */
  extraFiles?: readonly string[];
  providers: ReadonlyMap<string, PinCatalog>;
  dryRun?: boolean;
  now?: () => Date;
}

export interface MigratePinsResult {
  /** True when at least one file was rewritten. */
  written: boolean;
  lines: string[];
}

/** Rewrite stale pins in Pi's settings and the engineering policy files. */
export function migrateConfiguredPins(opts: MigratePinsOptions): MigratePinsResult {
  const lines: string[] = [];
  let written = false;
  const files = [
    join(opts.agentDir, "settings.json"),
    join(opts.agentDir, "engineering.yaml"),
    ...(opts.extraFiles ?? []),
  ];
  const stamp = `${(opts.now ?? (() => new Date()))().toISOString().slice(0, 19).replace(/[-:]/g, "")}Z`;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const before = readFileSync(file, "utf8");
    const plan = planPinMigration(before, opts.providers);
    for (const { provider, id } of plan.unresolved) {
      lines.push(`  pin not moved: ${file} names ${provider}/${id}, which no served alias covers`);
    }
    if (plan.changes.length === 0) continue;
    for (const c of plan.changes) lines.push(`  pin: ${c.provider}/${c.from} → ${c.provider}/${c.to} (${file})`);
    if (opts.dryRun) continue;
    const backup = `${file}.bak-${stamp}-model-refresh`;
    copyFileSync(file, backup);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, plan.text, { mode: statSync(file).mode & 0o777 });
    renameSync(tmp, file);
    lines.push(`  previous ${file} kept at ${backup}`);
    written = true;
  }
  if (lines.length > 0) lines.unshift("Pinned models moved onto aliases:");
  return { written, lines };
}
