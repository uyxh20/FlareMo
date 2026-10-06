// Fork-owned (docs/fork-customizations.md): the pure rules of the composer's
// "#" tag picker. Nothing here touches the DOM or React, so every rule is unit
// tested in tag-picker.test.ts. The state hook (use-tag-picker.ts), the list's
// DOM behaviour (use-tag-picker-list.ts) and the upstream composer files only
// call into this module.

/**
 * Rows the picker may list. The stats endpoint already sends every tag, so the
 * list is the whole vocabulary; this only bounds the DOM for a runaway one.
 * Passed to `filterTagSuggestions` at its call site, which keeps that
 * function's own default (and its upstream tests) as they are.
 */
export const FORK_TAG_PICKER_LIMIT = 500;

/** The tallest the list gets: about eight rows (the `max-h-72` class). */
export const TAG_PICKER_MAX_HEIGHT = 288;
/** The shortest it is squeezed to on a tiny screen: two and a half rows. */
export const TAG_PICKER_MIN_HEIGHT = 80;
/** Space between the list and the box it hangs from (`mt-1.5` / `mb-1.5`). */
export const TAG_PICKER_GAP = 6;
/** Space kept between the list and the edge of the area it must stay inside. */
export const TAG_PICKER_EDGE = 8;
/** Below the composer is chosen when this much fits there: about five rows. */
export const TAG_PICKER_ROOM = 170;
/** How far above the canvas's scroll area its list floats (`bottom-12`). */
export const TAG_PICKER_CANVAS_OFFSET = 48;

/**
 * Where the list hangs: from the timeline composer's box (below it, or above
 * it when there is no room below) or above the focus canvas's own toolbar.
 */
export type TagPickerAnchor = "composer" | "canvas";

/**
 * The row highlighted when a token first shows its matches: the best match as
 * soon as the person has typed a name (Tab or Enter completes it), nothing for
 * a bare "#" (so "#" then Enter is a plain new line, as it always was).
 */
export function defaultTagPickerIndex(tokenText: string): number {
  return tokenText.length > 0 ? 0 : -1;
}

// --- Keyboard ----------------------------------------------------------------

/** The parts of a KeyboardEvent the picker reads, so tests need no DOM. */
export type TagPickerKeyEvent = Pick<
  KeyboardEvent,
  | "key"
  | "shiftKey"
  | "ctrlKey"
  | "metaKey"
  | "altKey"
  | "isComposing"
  | "keyCode"
>;

export type TagPickerKeyState = {
  /** The list is on screen. */
  open: boolean;
  /** Rows in the list. */
  count: number;
  /** Highlighted row, -1 for none. */
  activeIndex: number;
};

export type TagPickerKeyAction =
  | { type: "ignore" }
  | { type: "move"; index: number }
  | { type: "accept"; index: number }
  | { type: "close" };

const IGNORE: TagPickerKeyAction = { type: "ignore" };

/**
 * What a keydown means to the picker: move the highlight (arrows wrap around),
 * accept the highlighted row (Tab or Enter, only when there is one), close the
 * list (Escape), or nothing, in which case the editor keeps the key.
 *
 * Never taken: any key with Shift, Ctrl, Meta or Alt held (Shift+Enter and
 * Cmd/Ctrl+Enter still send the note, Shift+Tab still goes back) and any key
 * during IME composition (Chinese and Japanese input is the input method's).
 */
export function tagPickerKeyAction(
  state: TagPickerKeyState,
  event: TagPickerKeyEvent,
): TagPickerKeyAction {
  const { open, count, activeIndex } = state;
  if (!open || count <= 0) return IGNORE;
  if (event.isComposing || event.keyCode === 229) return IGNORE;
  if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
    return IGNORE;
  }
  switch (event.key) {
    case "ArrowDown":
      return {
        type: "move",
        index: activeIndex < 0 ? 0 : (activeIndex + 1) % count,
      };
    case "ArrowUp":
      return {
        type: "move",
        index: activeIndex < 0 ? count - 1 : (activeIndex + count - 1) % count,
      };
    case "Enter":
    case "Tab":
      return activeIndex >= 0 && activeIndex < count
        ? { type: "accept", index: activeIndex }
        : IGNORE;
    case "Escape":
      return { type: "close" };
    default:
      return IGNORE;
  }
}

/**
 * Whether a dialog's close-on-Escape belongs to the picker instead: it does
 * when the list is open, or when the list has already used this very key (the
 * editor hears the key first, closes the list, and only then does the dialog
 * ask). `defaultPrevented` cannot say that: ProseMirror prevents the default
 * of every Escape and Enter it sees. Only the Escape key counts; a click
 * outside still closes the dialog.
 */
export function shouldClaimDialogEscape(input: {
  open: boolean;
  reason: string;
  /** The list closed itself on this very keypress. */
  usedByList: boolean;
}): boolean {
  return input.reason === "escape-key" && (input.open || input.usedByList);
}

/** What a dialog's `onOpenChange` is told besides the new state (Base UI's change details). */
export type DialogChangeDetails = {
  reason: string;
  event: Event;
  cancel: () => void;
};

/**
 * A dialog's `onOpenChange` that leaves its Escape to the "#" list when the
 * list has a use for it: the dialog stays open and only the list closes. Every
 * other change (a click outside, the close button, an Escape with no list)
 * reaches `onOpenChange` as before.
 */
export function withTagPickerEscape(
  claimEscape: (details: DialogChangeDetails) => boolean,
  onOpenChange: (open: boolean) => void,
): (open: boolean, details: DialogChangeDetails) => void {
  return (open, details) => {
    if (!open && claimEscape(details)) {
      details.cancel();
      return;
    }
    onOpenChange(open);
  };
}

// --- Pointer -----------------------------------------------------------------

/**
 * Whether a mouse move is the pointer really travelling. A list that scrolls
 * under a resting pointer (the arrow keys do that) makes the browser fire
 * moves with no travel, and those must not take the highlight away from the
 * key that just moved it.
 */
export function pointerTravelled(
  event: Pick<MouseEvent, "movementX" | "movementY">,
): boolean {
  return event.movementX !== 0 || event.movementY !== 0;
}

// --- Placement ---------------------------------------------------------------

export type TagPickerPlacement = {
  side: "below" | "above";
  /** Tallest the list may be so it stays inside the visible area, in px. */
  maxHeight: number;
};

/**
 * Clamp the room that is really there to a height the list can use: at most
 * eight rows, and never so small that the list is unusable (on a screen that
 * tiny some clipping is unavoidable, but a row or two stays reachable).
 */
export function fitTagPickerHeight(space: number): number {
  const room = Number.isFinite(space) ? space : TAG_PICKER_MAX_HEIGHT;
  return Math.round(
    Math.min(TAG_PICKER_MAX_HEIGHT, Math.max(TAG_PICKER_MIN_HEIGHT, room)),
  );
}

/**
 * Decide where the timeline composer's list opens, from the composer's box and
 * the visible area (viewport, narrowed by the keyboard and by any scrolling
 * ancestor), both in viewport pixels.
 *
 * Below the composer is the default: the notes are there, and the list never
 * covers the text being typed. It opens above only when below is cramped and
 * above has more to give.
 */
export function placeTagPicker(input: {
  anchor: { top: number; bottom: number };
  bounds: { top: number; bottom: number };
}): TagPickerPlacement {
  const margin = TAG_PICKER_GAP + TAG_PICKER_EDGE;
  const below = input.bounds.bottom - input.anchor.bottom - margin;
  const above = input.anchor.top - input.bounds.top - margin;
  const side = below >= TAG_PICKER_ROOM || below >= above ? "below" : "above";
  return {
    side,
    maxHeight: fitTagPickerHeight(side === "below" ? below : above),
  };
}
