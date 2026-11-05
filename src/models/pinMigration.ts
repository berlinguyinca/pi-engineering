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
import { sizeClassOf } from "./gatewayCatalog.ts";

export interface PinCatalog {
  /** Ids now configured for the provider. */
  ids: ReadonlySet<string>;
  /** Pins are only moved when the provider is configured with aliases. */
  aliasOnly: boolean;
  /**
   * What answers behind each alias (`x_members`), when the gateway publishes it.
   * Membership decides whether an alias can still answer as the model a pin
   * named; without it, the alias name decides.
   */
  members?: Readonly<Record<string, readonly string[]>>;
}

export interface PinChange {
  from: string;
  to: string;
  provider: string;
}

export interface PinPlan {
  text: string;
  changes: PinChange[];
  /** Stale pins that no served alias covers faithfully; left as written. */
  unresolved: Array<{ provider: string; id: string; blocked?: PinMoveBlock }>;
}

/**
 * Whether moving a pin from `stale` onto `alias` keeps the same model answering.
 *
 * The point is to refuse a move that silently changes which model runs: a pin on
 * the 27B build must not land on a family alias whose members are Flash, because
 * the session would then get Flash behind a name that says 27B. Membership
 * settles it when the gateway publishes it — the pinned model answering behind
 * the alias is the strongest possible evidence, and otherwise every member must
 * be of the pinned size class. Where membership is unpublished, the alias name is
 * the only evidence left, so it must carry the class. A pin whose id names no
 * class has nothing to preserve, and any covering alias is faithful.
 */
function answersAs(stale: string, alias: string, catalog: PinCatalog): boolean {
  const size = sizeClassOf(stale);
  const members = catalog.members?.[alias] ?? [];
  if (members.length > 0) {
    if (members.includes(stale)) return true;
    return size !== undefined && members.every((m) => sizeClassOf(m) === size);
  }
  return size === undefined || alias.toLowerCase().includes(size.toLowerCase());
}

/** Why a covering alias was refused, so the report can say what to pin instead. */
export interface PinMoveBlock {
  alias: string;
  because: string;
}

/** The move for a stale pin: the alias to use, and the nearest miss when there is none. */
export function pinMove(stale: string, catalog: PinCatalog): { to?: string; blocked?: PinMoveBlock } {
  // An operator alias need not resemble the id behind it — `qwen3.8-text` routes
  // to a `-vision-` build, `laya` to `laya-typed-decisions-…` — so membership is
  // its own source of candidates, not merely a check on the derived names. Those
  // come first and longest first: an alias the gateway proves resolves to the
  // pinned model beats a name inferred from its shape, and among proven aliases
  // the most specific name preserves the most intent.
  const resolved = Object.entries(catalog.members ?? {})
    .filter(([, ms]) => ms.includes(stale))
    .map(([alias]) => alias)
    .sort((a, b) => b.length - a.length);
  const candidates = [...resolved, ...pinCandidates(stale)];
  let blocked: PinMoveBlock | undefined;
  for (const candidate of candidates) {
    if (candidate === stale || !catalog.ids.has(candidate)) continue;
    if (answersAs(stale, candidate, catalog)) return { to: candidate };
    blocked ??= { alias: candidate, because: whyNot(stale, candidate, catalog) };
  }
  return { ...(blocked ? { blocked } : {}) };
}

/** Why the alias would answer as a different model than the pin named. */
function whyNot(stale: string, alias: string, catalog: PinCatalog): string {
  const size = sizeClassOf(stale);
  const members = (catalog.members?.[alias] ?? []).map(sizeClassOf).filter((c): c is string => !!c);
  const others = [...new Set(members)].sort();
  if (others.length > 0) return `its members are ${others.join(", ")}${size ? `, not ${size}` : ""}`;
  return size ? `neither its name nor its published members say ${size}` : "it names no model";
}

/** The alias that should replace a stale pinned id, or `undefined` when none covers it. */
export function aliasForPin(stale: string, catalog: PinCatalog): string | undefined {
  return pinMove(stale, catalog).to;
}

/** The alias names a stale id could move to, most specific first. */
function pinCandidates(stale: string): string[] {
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
  return candidates;
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
  const note = (provider: string, from: string, move: { to?: string; blocked?: PinMoveBlock }) => {
    if (move.to) changes.push({ provider, from, to: move.to });
    else if (!unresolved.some((u) => u.provider === provider && u.id === from))
      unresolved.push({ provider, id: from, ...(move.blocked ? { blocked: move.blocked } : {}) });
  };

  for (const [provider, catalog] of providers) {
    if (!catalog.aliasOnly) continue;
    // `provider/<id>`: a glob such as `provider/*` has no id characters and never matches.
    const pin = new RegExp(`(?<![A-Za-z0-9._/-])${escapeRe(provider)}/([A-Za-z0-9._-]+)`, "g");
    out = out.replace(pin, (whole, id: string) => {
      if (catalog.ids.has(id)) return whole;
      const move = pinMove(id, catalog);
      note(provider, id, move);
      return move.to ? `${provider}/${move.to}` : whole;
    });
  }

  // Pi's settings keep the default as two fields.
  const defaultProvider = /"defaultProvider"\s*:\s*"([^"]+)"/.exec(out)?.[1];
  const catalog = defaultProvider ? providers.get(defaultProvider) : undefined;
  if (defaultProvider && catalog?.aliasOnly) {
    out = out.replace(/("defaultModel"\s*:\s*")([^"]+)(")/, (whole, pre: string, id: string, post: string) => {
      if (catalog.ids.has(id)) return whole;
      const move = pinMove(id, catalog);
      note(defaultProvider, id, move);
      return move.to ? `${pre}${move.to}${post}` : whole;
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
    for (const { provider, id, blocked } of plan.unresolved) {
      lines.push(
        `  pin not moved: ${file} names ${provider}/${id}, which no served alias covers${
          blocked ? ` (${provider}/${blocked.alias} ${blocked.because})` : ""
        }`,
      );
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
