import { Key, decodeKittyPrintable, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { ALL_TAB, type ModelEntry, type ProviderTabsState } from "./providerTabs.ts";

/** The slice of Pi's theme this view uses, so tests can pass a plain stub. */
export interface TabsTheme {
  fg(color: "accent" | "muted" | "dim" | "success", text: string): string;
  bold(text: string): string;
}

const MAX_ROWS = 12;

/** Terminal view over {@link ProviderTabsState}: tab bar, filter, model list. */
export class ModelTabsComponent {
  private readonly state: ProviderTabsState;
  private readonly theme: TabsTheme;
  private readonly done: (result: ModelEntry | undefined) => void;
  private readonly requestRender: () => void;

  constructor(
    state: ProviderTabsState,
    theme: TabsTheme,
    done: (result: ModelEntry | undefined) => void,
    requestRender: () => void = () => {},
  ) {
    this.state = state;
    this.theme = theme;
    this.done = done;
    this.requestRender = requestRender;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const t = this.theme;
    const s = this.state;
    const fit = (line: string) => truncateToWidth(line, width);
    const bar = s.tabs
      .map((tab, i) => {
        const label = `${tab === ALL_TAB ? "all" : tab} ${s.count(tab)}`;
        return i === s.activeTabIndex ? t.bold(t.fg("accent", `[${label}]`)) : t.fg("muted", ` ${label} `);
      })
      .join(" ");
    const lines = [fit(bar), "", fit(`${t.fg("muted", "> ")}${s.query}`), ""];

    const items = s.visible;
    if (items.length === 0) lines.push(fit(t.fg("muted", "  No matching models")));
    const start = Math.max(0, Math.min(s.selectedIndex - Math.floor(MAX_ROWS / 2), items.length - MAX_ROWS));
    for (let i = start; i < Math.min(items.length, start + MAX_ROWS); i++) {
      const m = items[i] as ModelEntry;
      const cursor = i === s.selectedIndex ? t.fg("accent", "→ ") : "  ";
      const mark = s.isCurrent(m) ? t.fg("success", "✓ ") : "";
      const provider = s.tab === ALL_TAB ? ` ${t.fg("muted", `[${m.provider}]`)}` : "";
      const badge = s.isDefault(m) ? t.fg("dim", " · default") : "";
      lines.push(fit(`${cursor}${mark}${m.id}${provider}${badge}`));
    }
    if (items.length > MAX_ROWS) lines.push(fit(t.fg("muted", `  (${s.selectedIndex + 1}/${items.length})`)));
    const picked = s.selected;
    if (picked?.name && picked.name !== picked.id) lines.push("", fit(t.fg("muted", `  ${picked.name}`)));
    lines.push("", fit(t.fg("muted", "←/→ or tab: provider · ↑/↓: move · type: filter · enter: select · esc: cancel")));
    return lines;
  }

  handleInput(data: string): void {
    const s = this.state;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done(s.selected);
      return;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) s.nextTab(1);
    else if (matchesKey(data, Key.left) || matchesKey(data, Key.shift("tab"))) s.nextTab(-1);
    else if (matchesKey(data, Key.down)) s.move(1);
    else if (matchesKey(data, Key.up)) s.move(-1);
    else if (matchesKey(data, Key.backspace)) s.setQuery(s.query.slice(0, -1));
    else {
      const ch = decodeKittyPrintable(data) ?? (data.length === 1 && data >= " " && data !== "\x7f" ? data : undefined);
      if (ch === undefined) return;
      s.setQuery(s.query + ch);
    }
    this.requestRender();
  }
}
