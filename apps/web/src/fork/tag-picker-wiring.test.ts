/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The "#" picker's hook-ins in upstream files are a handful of lines each. If
// an upstream sync drops one, the feature quietly stops working (no keyboard
// completion, a list cut off at six rows, Escape closing the canvas), so these
// fail loudly instead. See docs/fork-customizations.md.

const source = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("the tag picker hook-ins", () => {
  it("useComposerSuggestions asks for the whole tag list and runs the picker", () => {
    const hook = source("hooks/use-composer-suggestions.ts");
    expect(hook).toContain('from "@/fork/tag-picker"');
    expect(hook).toContain("FORK_TAG_PICKER_LIMIT");
    expect(hook).toContain('from "@/fork/use-tag-picker"');
    expect(hook).toMatch(/useTagPicker\(/);
    for (const name of [
      "activeTagIndex",
      "setActiveTagIndex",
      "handleSuggestionKeyDown",
      "claimDialogEscape",
    ]) {
      expect(hook, name).toContain(name);
    }
  });

  it("the editor offers every keydown to onSuggestionKeyDown first", () => {
    const editor = source("components/rich-composer-editor.tsx");
    expect(editor).toContain("onSuggestionKeyDown");
    expect(editor).toContain("onSuggestionKeyDownRef.current?.(event)");
  });

  it("the list uses the fork's DOM behaviour and listbox semantics", () => {
    const list = source("components/composer/composer-suggestion-lists.tsx");
    expect(list).toContain('from "@/fork/use-tag-picker-list"');
    expect(list).toMatch(/useTagPickerList\(/);
    expect(list).toContain('role="listbox"');
    expect(list).toContain('role="option"');
    expect(list).toContain("aria-selected");
    expect(list).toContain("overscroll-contain");
    expect(list).toContain("pointerTravelled(event)");
  });

  it("the timeline composer wires the keys and the highlight", () => {
    const composer = source("components/memo-composer.tsx");
    expect(composer).toContain("onSuggestionKeyDown={handleSuggestionKeyDown}");
    expect(composer).toContain("activeIndex={activeTagIndex}");
    expect(composer).toContain("onActiveIndexChange={setActiveTagIndex}");
  });

  it("the focus canvas wires the keys, the highlight and the Escape claim", () => {
    const canvas = source("components/composer/composer-focus-canvas.tsx");
    expect(canvas).toContain("onSuggestionKeyDown={handleSuggestionKeyDown}");
    expect(canvas).toContain("activeIndex={activeTagIndex}");
    expect(canvas).toContain("onActiveIndexChange={setActiveTagIndex}");
    expect(canvas).toContain('anchor="canvas"');
    expect(canvas).toMatch(
      /onOpenChange=\{\s*withTagPickerEscape\(\s*claimDialogEscape,\s*onOpenChange\s*\)\s*\}/,
    );
  });
});
