/**
 * Panel controller — overlay lifecycle and the hotkey.
 *
 * Pi's extension API registers commands but NOT app keybindings, so the hotkey
 * is a raw input handler that consumes exactly one configured chord and passes
 * every other keystroke through untouched. It is configurable, and settable to
 * `none`, so it can never shadow a binding the operator depends on.
 */

import { PanelComponent } from "./PanelComponent.ts";
import type { PanelState } from "./PanelState.ts";
import type { ContentView } from "./content.ts";
import type { PanelLayout, PanelLayoutPatch } from "./layout.ts";
import type { RowPayload } from "./tree.ts";

/** Below this many columns the overlay would crowd the chat rather than help. */
export const MIN_TERMINAL_COLUMNS = 100;
/** Floor for the overlay's own width. */
export const MIN_PANEL_COLUMNS = 36;
export const DEFAULT_CHORD = "ctrl+p";

/**
 * Does this raw input match the configured chord?
 *
 * Only `ctrl+<letter>` is supported, which is what a terminal delivers as a
 * single control byte. `none` (or an empty chord) matches nothing.
 */
export function matchesChord(data: string, chord: string): boolean {
  if (!chord || chord === "none") return false;
  const match = /^ctrl\+([a-z])$/i.exec(chord.trim());
  if (!match) return false;
  const letter = match[1]!.toLowerCase();
  const code = letter.charCodeAt(0) - 96; // ctrl+a === 1
  return data === String.fromCharCode(code);
}

/** The slice of Pi's overlay handle the controller uses. */
interface OverlayHandleLike {
  hide(): void;
  /**
   * Focus controls. Optional because the smoke-test stub and older pi builds
   * supply only `hide`, and a panel must still work where they are absent —
   * it is simply always-visible and never interactive there.
   */
  focus?(): void;
  unfocus?(): void;
  isFocused?(): boolean;
}

/** The slice of Pi's UI context the controller uses. */
interface PanelUi {
  custom(
    factory: (
      tui: { requestRender: () => void },
      theme: unknown,
      keybindings: unknown,
      done: (v: unknown) => void,
    ) => unknown,
    options?: {
      overlay?: boolean;
      overlayOptions?: () => Record<string, unknown>;
      onHandle?: (handle: OverlayHandleLike) => void;
    },
  ): Promise<unknown>;
}

export interface PanelControllerOptions {
  state: PanelState;
  ui: PanelUi;
  /** Hotkey, e.g. "ctrl+p". Pass "none" to disable. */
  chord?: string;
  /** Called when the panel is opened, so feeders can refresh. */
  onOpen?: () => void;
  /** Resolve a selected row into something to display. */
  openRow?: (payload: RowPayload) => Promise<ContentView | undefined> | ContentView | undefined;
  /** Layout to open with; the panel remembers it across sessions. */
  layout?: PanelLayout;
  /** Called whenever the operator changes tab, width, or expansion. */
  onLayoutChange?: (layout: PanelLayoutPatch) => void;
  /**
   * Called when the operator opens or closes the panel, so the preference
   * outlives the session. Separate from `onLayoutChange` because that carries
   * the component's fields and this one is the controller's.
   */
  onVisibilityChange?: (open: boolean) => void;
  /**
   * Called whenever the panel stops being on screen — a toggle, the component
   * closing itself, or session shutdown. Distinct from `onVisibilityChange`,
   * which records a PREFERENCE; this one is for releasing work that only makes
   * sense while the panel is visible, and must fire on every path including the
   * ones that record nothing.
   */
  onHidden?: () => void;
}

export class PanelController {
  private readonly state: PanelState;
  private readonly ui: PanelUi;
  private readonly chord: string;
  private readonly onOpen: (() => void) | undefined;
  private readonly openRowFn: PanelControllerOptions["openRow"];
  private layout: PanelLayout | undefined;
  private readonly onLayoutChange: ((layout: PanelLayoutPatch) => void) | undefined;
  private readonly onVisibilityChange: ((open: boolean) => void) | undefined;
  private readonly onHidden: (() => void) | undefined;

  private handle: OverlayHandleLike | null = null;
  private component: PanelComponent | null = null;
  private open = false;

  constructor(opts: PanelControllerOptions) {
    this.state = opts.state;
    this.ui = opts.ui;
    this.chord = opts.chord ?? DEFAULT_CHORD;
    this.onOpen = opts.onOpen;
    this.openRowFn = opts.openRow;
    this.layout = opts.layout;
    this.onLayoutChange = opts.onLayoutChange;
    this.onVisibilityChange = opts.onVisibilityChange;
    this.onHidden = opts.onHidden;
  }

  isOpen(): boolean {
    return this.open;
  }

  /**
   * Raw terminal input. Returns `{ consume: true }` only for our own chord;
   * everything else is passed through untouched.
   */
  handleTerminalInput(data: string): { consume: true } | undefined {
    if (!matchesChord(data, this.chord)) return undefined;
    // The chord moves focus rather than hiding the panel: `/panel` is for
    // showing and hiding, this is for stepping in and out.
    this.toggleFocus();
    return { consume: true };
  }

  /** Whether the panel currently holds the keyboard. */
  get focused(): boolean {
    return this.handle?.isFocused?.() === true;
  }

  /**
   * Give the panel the keyboard so it can be navigated.
   *
   * Separate from visibility on purpose: the panel is visible nearly always and
   * interactive rarely, and conflating the two is what made "always visible"
   * mean "cannot type".
   */
  focus(): void {
    if (!this.open) this.show();
    this.handle?.focus?.();
  }

  /** Hand the keyboard back to the prompt, leaving the panel on screen. */
  blur(): void {
    this.handle?.unfocus?.();
  }

  /** The chord: step into the panel, or back out of it. */
  toggleFocus(): void {
    if (this.focused) this.blur();
    else this.focus();
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
    // Only a toggle records a preference. `dispose()` closes the panel too, and
    // a session ending is not the operator saying they want it shut.
    this.onVisibilityChange?.(this.open);
  }

  /**
   * Show the panel without recording a preference.
   *
   * Used to restore a remembered "open" at session start: that is honouring a
   * choice already made, not making a new one.
   */
  restore(): void {
    if (!this.open) this.show();
  }

  dispose(): void {
    this.close();
  }

  private close(): void {
    const wasOpen = this.open;
    this.component?.dispose();
    this.component = null;
    this.handle?.hide();
    this.handle = null;
    this.open = false;
    // Only when it was actually on screen: close() is idempotent and is called
    // on paths that may already have closed it.
    if (wasOpen) this.onHidden?.();
  }

  private show(): void {
    this.open = true;
    this.onOpen?.();
    // `.catch`, not `void`: a rejected overlay promise with no handler is an
    // unhandled rejection, which in a Node process is a crash waiting on a
    // flag. A panel that cannot be drawn closes itself instead.
    const overlay = this.ui.custom(
      (tui) => {
        this.component = new PanelComponent({
          state: this.state,
          requestRender: () => tui.requestRender(),
          // Escape releases focus back to the prompt; it does not hide the
          // panel. Ambient visibility is the point — you stop interacting with
          // it far more often than you want it gone.
          onClose: () => this.blur(),
          openRow: (payload) => void this.openSelection(payload),
          ...(this.layout ? { layout: this.layout } : {}),
          onLayoutChange: (patch) => {
            // Held locally too, so re-opening within the session keeps the tab
            // and width without a file read. Open/closed is merged in here
            // rather than taken from the component: the component draws the
            // panel, it does not decide whether the panel exists, and letting a
            // width nudge republish `open` would rewrite a deliberate close.
            this.layout = { ...patch, open: this.layout?.open ?? true };
            this.onLayoutChange?.(patch);
          },
        });
        return this.component;
      },
      {
        overlay: true,
        overlayOptions: () => ({
          anchor: "top-right",
          width: `${this.layout?.widthPercent ?? 35}%`,
          minWidth: MIN_PANEL_COLUMNS,
          // Leave the lower half of the terminal to the transcript. Without a
          // ceiling the overlay claims rows it has nothing to draw in, which
          // reads as a washed-out block rather than a panel.
          maxHeight: "60%" as const,
          margin: 1,
          // The field that makes an always-visible panel possible at all:
          // without it the overlay seizes the keyboard the moment it appears,
          // and pi accepts no typing until it is closed. `ui.custom()`'s own
          // doc comment says "with keyboard focus" and does not mention this,
          // which is how an always-on panel got shipped and reverted before
          // anyone read OverlayOptions.
          nonCapturing: true,
          // Called every render cycle, so it stays a comparison and nothing more.
          visible: (termWidth: number) => termWidth >= MIN_TERMINAL_COLUMNS,
        }),
        onHandle: (handle) => {
          this.handle = handle;
        },
      },
    );
    // A failure to draw is reported through the same path as a close, so the
    // controller's `open` flag never claims a panel that is not there.
    void Promise.resolve(overlay).catch(() => this.close());
  }

  private async openSelection(payload: RowPayload): Promise<void> {
    if (!this.openRowFn) return;
    try {
      const view = await this.openRowFn(payload);
      if (view) this.component?.showContent(view);
    } catch (err) {
      this.component?.showContent({
        title: "error",
        lines: [],
        truncated: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
