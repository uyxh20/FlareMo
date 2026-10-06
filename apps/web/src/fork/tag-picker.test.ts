import { describe, expect, it, vi } from "vitest";
import { filterTagSuggestions } from "@/lib/tag-autocomplete";
import {
  defaultTagPickerIndex,
  FORK_TAG_PICKER_LIMIT,
  fitTagPickerHeight,
  placeTagPicker,
  pointerTravelled,
  shouldClaimDialogEscape,
  TAG_PICKER_EDGE,
  TAG_PICKER_GAP,
  TAG_PICKER_MAX_HEIGHT,
  TAG_PICKER_MIN_HEIGHT,
  TAG_PICKER_ROOM,
  type TagPickerKeyEvent,
  type TagPickerKeyState,
  tagPickerKeyAction,
  withTagPickerEscape,
} from "./tag-picker";

function key(name: string, overrides: Partial<TagPickerKeyEvent> = {}) {
  return {
    key: name,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    ...overrides,
  } satisfies TagPickerKeyEvent;
}

function state(overrides: Partial<TagPickerKeyState> = {}): TagPickerKeyState {
  return { open: true, count: 5, activeIndex: -1, ...overrides };
}

describe("the picker's row limit", () => {
  const tags = Array.from({ length: 40 }, (_, index) => ({
    name: `tag${String(index).padStart(2, "0")}`,
    count: index % 7,
  }));

  it("lists every tag for a bare #, most used first and then A to Z", () => {
    const listed = filterTagSuggestions(tags, "", FORK_TAG_PICKER_LIMIT);
    expect(listed).toHaveLength(40);
    for (let index = 1; index < listed.length; index += 1) {
      const before = listed[index - 1];
      const after = listed[index];
      if (!before || !after) throw new Error("missing row");
      expect(
        before.count > after.count ||
          (before.count === after.count &&
            before.name.localeCompare(after.name) <= 0),
      ).toBe(true);
    }
  });

  it("lists every match for typed text, exact then prefix then substring", () => {
    const named = [
      { name: "car", count: 1 },
      { name: "carlsberg", count: 3 },
      { name: "cargo", count: 5 },
      { name: "scarf", count: 9 },
      { name: "oscar", count: 2 },
    ];
    expect(
      filterTagSuggestions(named, "CAR", FORK_TAG_PICKER_LIMIT).map(
        (tag) => tag.name,
      ),
    ).toEqual(["car", "cargo", "carlsberg", "scarf", "oscar"]);
  });

  it("keeps filterTagSuggestions' own default of six", () => {
    expect(filterTagSuggestions(tags, "")).toHaveLength(6);
  });

  it("is a safety bound far above any real tag list", () => {
    expect(FORK_TAG_PICKER_LIMIT).toBeGreaterThanOrEqual(500);
  });
});

describe("defaultTagPickerIndex", () => {
  it("highlights the best match once a name is typed, nothing for a bare #", () => {
    expect(defaultTagPickerIndex("c")).toBe(0);
    expect(defaultTagPickerIndex("carlsberg")).toBe(0);
    expect(defaultTagPickerIndex("")).toBe(-1);
  });
});

describe("tagPickerKeyAction", () => {
  it("ignores every key while the list is closed or empty", () => {
    for (const name of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
      expect(
        tagPickerKeyAction(state({ open: false, activeIndex: 1 }), key(name)),
      ).toEqual({ type: "ignore" });
      expect(
        tagPickerKeyAction(state({ count: 0, activeIndex: 0 }), key(name)),
      ).toEqual({ type: "ignore" });
    }
  });

  it("moves down from nothing to the first row and wraps at the end", () => {
    expect(tagPickerKeyAction(state(), key("ArrowDown"))).toEqual({
      type: "move",
      index: 0,
    });
    expect(
      tagPickerKeyAction(state({ activeIndex: 2 }), key("ArrowDown")),
    ).toEqual({ type: "move", index: 3 });
    expect(
      tagPickerKeyAction(state({ activeIndex: 4 }), key("ArrowDown")),
    ).toEqual({ type: "move", index: 0 });
  });

  it("moves up from nothing to the last row and wraps at the start", () => {
    expect(tagPickerKeyAction(state(), key("ArrowUp"))).toEqual({
      type: "move",
      index: 4,
    });
    expect(
      tagPickerKeyAction(state({ activeIndex: 3 }), key("ArrowUp")),
    ).toEqual({ type: "move", index: 2 });
    expect(
      tagPickerKeyAction(state({ activeIndex: 0 }), key("ArrowUp")),
    ).toEqual({ type: "move", index: 4 });
  });

  it("accepts the highlighted row on Tab and on Enter", () => {
    for (const name of ["Tab", "Enter"]) {
      expect(tagPickerKeyAction(state({ activeIndex: 2 }), key(name))).toEqual({
        type: "accept",
        index: 2,
      });
    }
  });

  it("leaves Tab and Enter to the editor while no row is highlighted", () => {
    for (const name of ["Tab", "Enter"]) {
      expect(tagPickerKeyAction(state({ activeIndex: -1 }), key(name))).toEqual(
        { type: "ignore" },
      );
    }
  });

  it("closes on Escape, with or without a highlighted row", () => {
    expect(tagPickerKeyAction(state(), key("Escape"))).toEqual({
      type: "close",
    });
    expect(
      tagPickerKeyAction(state({ activeIndex: 3 }), key("Escape")),
    ).toEqual({ type: "close" });
  });

  it("never takes a key with Shift, Ctrl, Meta or Alt held", () => {
    for (const name of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
      for (const modifier of [
        "shiftKey",
        "ctrlKey",
        "metaKey",
        "altKey",
      ] as const) {
        expect(
          tagPickerKeyAction(
            state({ activeIndex: 1 }),
            key(name, { [modifier]: true }),
          ),
        ).toEqual({ type: "ignore" });
      }
    }
  });

  it("never takes a key during IME composition", () => {
    for (const name of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
      expect(
        tagPickerKeyAction(
          state({ activeIndex: 1 }),
          key(name, { isComposing: true }),
        ),
      ).toEqual({ type: "ignore" });
      // Safari reports the committing Enter as keyCode 229 after compositionend.
      expect(
        tagPickerKeyAction(
          state({ activeIndex: 1 }),
          key(name, { keyCode: 229 }),
        ),
      ).toEqual({ type: "ignore" });
    }
  });

  it("ignores keys it has no use for", () => {
    for (const name of ["a", "#", "Backspace", " ", "ArrowLeft", "Home"]) {
      expect(tagPickerKeyAction(state({ activeIndex: 1 }), key(name))).toEqual({
        type: "ignore",
      });
    }
  });
});

describe("shouldClaimDialogEscape", () => {
  it("claims the Escape while the list is open", () => {
    expect(
      shouldClaimDialogEscape({
        open: true,
        reason: "escape-key",
        usedByList: false,
      }),
    ).toBe(true);
  });

  it("claims an Escape the list already used to close itself", () => {
    expect(
      shouldClaimDialogEscape({
        open: false,
        reason: "escape-key",
        usedByList: true,
      }),
    ).toBe(true);
  });

  it("leaves the dialog to close when the list has nothing to do with the key", () => {
    expect(
      shouldClaimDialogEscape({
        open: false,
        reason: "escape-key",
        usedByList: false,
      }),
    ).toBe(false);
  });

  it("never claims a close that is not the Escape key", () => {
    for (const reason of ["outside-press", "close-press", "trigger-press"]) {
      expect(
        shouldClaimDialogEscape({ open: true, reason, usedByList: true }),
      ).toBe(false);
    }
  });
});

describe("withTagPickerEscape", () => {
  function setup(claims: boolean) {
    const onOpenChange = vi.fn();
    const cancel = vi.fn();
    const claimEscape = vi.fn(() => claims);
    const handler = withTagPickerEscape(claimEscape, onOpenChange);
    const details = (reason: string) => ({
      reason,
      event: new Event("keydown"),
      cancel,
    });
    return { onOpenChange, cancel, claimEscape, handler, details };
  }

  it("keeps the dialog open and closes only the list when the list claims the Escape", () => {
    const { handler, details, onOpenChange, cancel, claimEscape } = setup(true);
    const escapeKey = details("escape-key");
    handler(false, escapeKey);
    expect(claimEscape).toHaveBeenCalledWith(escapeKey);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes the dialog when the list does not claim it", () => {
    const { handler, details, onOpenChange, cancel } = setup(false);
    handler(false, details("escape-key"));
    expect(cancel).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("never asks the list about an opening", () => {
    const { handler, details, onOpenChange, claimEscape } = setup(true);
    handler(true, details("trigger-press"));
    expect(claimEscape).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("passes every other way of closing straight through", () => {
    const { handler, details, onOpenChange, cancel } = setup(false);
    for (const reason of ["outside-press", "close-press", "focus-out"]) {
      handler(false, details(reason));
    }
    expect(onOpenChange).toHaveBeenCalledTimes(3);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("pointerTravelled", () => {
  it("is true when the pointer moved in either direction", () => {
    expect(pointerTravelled({ movementX: 3, movementY: 0 })).toBe(true);
    expect(pointerTravelled({ movementX: 0, movementY: -2 })).toBe(true);
    expect(pointerTravelled({ movementX: -1, movementY: 4 })).toBe(true);
  });

  it("is false for the moves a browser fires under a resting pointer", () => {
    expect(pointerTravelled({ movementX: 0, movementY: 0 })).toBe(false);
  });
});

describe("fitTagPickerHeight", () => {
  it("never exceeds about eight rows", () => {
    expect(fitTagPickerHeight(10_000)).toBe(TAG_PICKER_MAX_HEIGHT);
  });

  it("follows the room that is really there", () => {
    expect(fitTagPickerHeight(200)).toBe(200);
    expect(fitTagPickerHeight(123.6)).toBe(124);
  });

  it("never shrinks to nothing on a tiny screen", () => {
    expect(fitTagPickerHeight(10)).toBe(TAG_PICKER_MIN_HEIGHT);
    expect(fitTagPickerHeight(-40)).toBe(TAG_PICKER_MIN_HEIGHT);
  });

  it("falls back to the default height for a measurement that is not a number", () => {
    expect(fitTagPickerHeight(Number.NaN)).toBe(TAG_PICKER_MAX_HEIGHT);
  });
});

describe("placeTagPicker", () => {
  const margin = TAG_PICKER_GAP + TAG_PICKER_EDGE;

  it("opens below the composer when there is room, up to eight rows", () => {
    // A composer at the top of a tall page body.
    const placement = placeTagPicker({
      anchor: { top: 80, bottom: 230 },
      bounds: { top: 56, bottom: 900 },
    });
    expect(placement).toEqual({ side: "below", maxHeight: 288 });
  });

  it("caps the height to the room below when that is all there is", () => {
    const placement = placeTagPicker({
      anchor: { top: 80, bottom: 230 },
      bounds: { top: 56, bottom: 230 + margin + TAG_PICKER_ROOM },
    });
    expect(placement).toEqual({ side: "below", maxHeight: TAG_PICKER_ROOM });
  });

  it("opens above when below is cramped and above has more to give", () => {
    const placement = placeTagPicker({
      anchor: { top: 500, bottom: 650 },
      bounds: { top: 56, bottom: 700 },
    });
    expect(placement.side).toBe("above");
    // 500 - 56 - margin, capped at eight rows.
    expect(placement.maxHeight).toBe(TAG_PICKER_MAX_HEIGHT);
  });

  it("stays below when both sides are cramped but below is the bigger one", () => {
    const placement = placeTagPicker({
      anchor: { top: 90, bottom: 140 },
      bounds: { top: 56, bottom: 300 },
    });
    expect(placement.side).toBe("below");
    expect(placement.maxHeight).toBe(300 - 140 - margin);
  });

  it("never counts the area behind the sticky header as room above", () => {
    // The composer sits right under the header: bounds.top is the header's
    // bottom edge, not the top of the window, so there is nothing above.
    const placement = placeTagPicker({
      anchor: { top: 60, bottom: 120 },
      bounds: { top: 56, bottom: 130 },
    });
    expect(placement.side).toBe("below");
    expect(placement.maxHeight).toBe(TAG_PICKER_MIN_HEIGHT);
  });

  it("uses the keyboard-shrunk viewport as the bottom edge", () => {
    // 844 high phone, keyboard up: the visual viewport ends at 480.
    const withKeyboard = placeTagPicker({
      anchor: { top: 112, bottom: 282 },
      bounds: { top: 56, bottom: 480 },
    });
    expect(withKeyboard).toEqual({
      side: "below",
      maxHeight: 480 - 282 - margin,
    });
    const withoutKeyboard = placeTagPicker({
      anchor: { top: 112, bottom: 282 },
      bounds: { top: 56, bottom: 844 },
    });
    expect(withoutKeyboard.maxHeight).toBe(TAG_PICKER_MAX_HEIGHT);
  });
});
