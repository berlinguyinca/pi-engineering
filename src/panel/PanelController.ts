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
}

export class PanelController {
  private readonly state: PanelState;
  private readonly ui: PanelUi;
  private readonly chord: string;
  private readonly onOpen: (() => void) | undefined;
  private readonly openRowFn: PanelControllerOptions["openRow"];

  private handle: OverlayHandleLike | null = null;
  private component: PanelComponent | null = null;
  private open = false;

  constructor(opts: PanelControllerOptions) {
    this.state = opts.state;
    this.ui = opts.ui;
    this.chord = opts.chord ?? DEFAULT_CHORD;
    this.onOpen = opts.onOpen;
    this.openRowFn = opts.openRow;
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
    this.toggle();
    return { consume: true };
  }

  toggle(): void {
    if (this.open) this.close();
    else this.show();
  }

  dispose(): void {
    this.close();
  }

  private close(): void {
    this.component?.dispose();
    this.component = null;
    this.handle?.hide();
    this.handle = null;
    this.open = false;
  }

  private show(): void {
    this.open = true;
    this.onOpen?.();
    void this.ui.custom(
      (tui) => {
        this.component = new PanelComponent({
          state: this.state,
          requestRender: () => tui.requestRender(),
          onClose: () => this.close(),
          openRow: (payload) => void this.openSelection(payload),
        });
        return this.component;
      },
      {
        overlay: true,
        overlayOptions: () => ({
          anchor: "top-right",
          width: "35%",
          minWidth: MIN_PANEL_COLUMNS,
          margin: 1,
          // Called every render cycle, so it stays a comparison and nothing more.
          visible: (termWidth: number) => termWidth >= MIN_TERMINAL_COLUMNS,
        }),
        onHandle: (handle) => {
          this.handle = handle;
        },
      },
    );
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
