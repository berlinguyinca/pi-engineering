/**
 * Provider-tabbed model picker state.
 *
 * Pi's built-in `/model` selector offers an "all | scoped" scope toggle, which
 * mixes every provider into one list. This is the pure model behind `/models`:
 * one tab per provider plus an "all" tab, a type-to-filter query, and a
 * selection cursor. It holds no terminal code so it can be tested directly.
 */

export interface ModelEntry {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}

export const ALL_TAB = "all";

export interface ProviderTabsOptions {
  /** The model in use; its provider's tab opens first and it sorts first. */
  readonly current?: { readonly provider: string; readonly id: string };
  /** The configured default model; it sorts right after the current one. */
  readonly defaultModel?: { readonly provider: string; readonly id: string };
}

const sameModel = (a: ModelEntry, b: { provider: string; id: string } | undefined): boolean =>
  b !== undefined && a.provider === b.provider && a.id === b.id;

/** Tabs are "all" first, then providers alphabetically. */
export function buildTabs(models: readonly ModelEntry[]): string[] {
  return [ALL_TAB, ...[...new Set(models.map((m) => m.provider))].sort((a, b) => a.localeCompare(b))];
}

function searchText(m: ModelEntry): string {
  return `${m.provider}/${m.id} ${m.id} ${m.name ?? ""}`.toLowerCase();
}

/** Every whitespace-separated token must appear somewhere in the model's text. */
export function matchesQuery(m: ModelEntry, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const text = searchText(m);
  return tokens.every((t) => text.includes(t));
}

export class ProviderTabsState {
  readonly tabs: string[];
  private readonly models: ModelEntry[];
  private tabIndex = 0;
  private queryText = "";
  private cursor = 0;
  private readonly options: ProviderTabsOptions;

  constructor(models: readonly ModelEntry[], options: ProviderTabsOptions = {}) {
    this.options = options;
    this.models = [...models].sort((a, b) => this.rank(a) - this.rank(b) || a.id.localeCompare(b.id));
    this.tabs = buildTabs(this.models);
    const start = options.current ? this.tabs.indexOf(options.current.provider) : -1;
    this.tabIndex = start >= 0 ? start : 0;
    this.cursor = this.currentIndexInView();
  }

  get tab(): string {
    return this.tabs[this.tabIndex] ?? ALL_TAB;
  }

  get activeTabIndex(): number {
    return this.tabIndex;
  }

  get query(): string {
    return this.queryText;
  }

  /** Models in the active tab that match the query, current/default first. */
  get visible(): ModelEntry[] {
    const tab = this.tab;
    return this.models.filter((m) => (tab === ALL_TAB || m.provider === tab) && matchesQuery(m, this.queryText));
  }

  /** Number of models per tab ignoring the query, for the tab headers. */
  count(tab: string): number {
    return tab === ALL_TAB ? this.models.length : this.models.filter((m) => m.provider === tab).length;
  }

  get selectedIndex(): number {
    return this.cursor;
  }

  get selected(): ModelEntry | undefined {
    return this.visible[this.cursor];
  }

  isCurrent(m: ModelEntry): boolean {
    return sameModel(m, this.options.current);
  }

  isDefault(m: ModelEntry): boolean {
    return sameModel(m, this.options.defaultModel);
  }

  nextTab(step = 1): void {
    const n = this.tabs.length;
    this.tabIndex = (((this.tabIndex + step) % n) + n) % n;
    this.cursor = this.currentIndexInView();
  }

  /** Jump to a tab by 1-based position ("all" is 1). Out of range is ignored. */
  gotoTab(position: number): void {
    if (position < 1 || position > this.tabs.length) return;
    this.tabIndex = position - 1;
    this.cursor = this.currentIndexInView();
  }

  move(delta: number): void {
    const n = this.visible.length;
    if (n === 0) return;
    this.cursor = (((this.cursor + delta) % n) + n) % n;
  }

  setQuery(query: string): void {
    this.queryText = query;
    this.cursor = 0;
  }

  private rank(m: ModelEntry): number {
    if (sameModel(m, this.options.current)) return 0;
    if (sameModel(m, this.options.defaultModel)) return 1;
    return 2;
  }

  private currentIndexInView(): number {
    const i = this.visible.findIndex((m) => sameModel(m, this.options.current));
    return i >= 0 ? i : 0;
  }
}
