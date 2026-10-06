// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type UseComposerSuggestionsResult,
  useComposerSuggestions,
} from "@/hooks/use-composer-suggestions";
import type { TagSuggestion } from "@/lib/tag-autocomplete";
import { type ForkTestMount, forkTestMount } from "./test-render";
import { editorElement } from "./use-tag-picker";

// useComposerSuggestions with a fake editor that records what the picker
// types into it: the keyboard side of the "#" tag picker, below the DOM.

const tags: TagSuggestion[] = [
  { name: "bender", count: 9 },
  { name: "carlsberg", count: 5 },
  { name: "cargo", count: 2 },
  { name: "gym", count: 1 },
];

type Insert = { range: { from: number; to: number }; content: unknown };

function fakeEditor(dom?: Element) {
  const inserts: Insert[] = [];
  const editor = {
    // Like TipTap, which throws on `view` until the editor is mounted.
    get view() {
      if (!dom) throw new Error("the editor view is not available");
      return { dom };
    },
    chain: () => ({
      focus: () => ({
        insertContentAt: (range: Insert["range"], content: unknown) => ({
          run: () => {
            inserts.push({ range, content });
            return true;
          },
        }),
      }),
    }),
  } as unknown as Editor;
  return { editor, inserts };
}

function key(name: string, overrides: Partial<KeyboardEvent> = {}) {
  return {
    key: name,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    ...overrides,
  } as KeyboardEvent;
}

let mounted: ForkTestMount | undefined;
/** Elements a test put on the page next to the hook, removed after it. */
const pageNodes: Element[] = [];

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  for (const node of pageNodes.splice(0)) node.remove();
});

function setup(
  options: {
    tags?: TagSuggestion[];
    isPending?: boolean;
    /** A mounted editor DOM node (default), or none: TipTap's `view` throws. */
    withDom?: boolean;
    /** The editor already has the focus when the hook mounts (default). */
    focused?: boolean;
  } = {},
) {
  const dom =
    options.withDom === false ? undefined : document.createElement("div");
  if (dom) dom.tabIndex = 0;
  const inside = dom?.appendChild(document.createElement("p"));
  const elsewhere = document.createElement("button");
  document.body.append(elsewhere);
  pageNodes.push(elsewhere);
  if (dom) {
    document.body.append(dom);
    pageNodes.push(dom);
    // Like the focus canvas, whose editor takes the focus before the hook's
    // effects run.
    if (options.focused !== false) dom.focus();
  }
  const { editor, inserts } = fakeEditor(dom);
  const editorRef = { current: editor };
  const latest: { current: UseComposerSuggestionsResult | null } = {
    current: null,
  };
  function Probe({ isPending }: { isPending: boolean }) {
    latest.current = useComposerSuggestions({
      editorRef,
      isPending,
      tags: options.tags ?? tags,
    });
    return null;
  }
  const client = new QueryClient();
  const tree = (isPending: boolean) => (
    <QueryClientProvider client={client}>
      <Probe isPending={isPending} />
    </QueryClientProvider>
  );
  mounted = forkTestMount(tree(options.isPending ?? false));
  const mount = mounted;
  const result = () => {
    if (!latest.current) throw new Error("hook did not render");
    return latest.current;
  };
  return {
    inserts,
    result,
    /** The editor reports the "#" token under the caret. */
    type: (from: number, text: string) =>
      act(() => result().setActiveTagToken({ from, text })),
    clearToken: () => act(() => result().setActiveTagToken(null)),
    /** A keydown, as the editor hands it to the picker. */
    press: (
      name: string,
      overrides: Partial<KeyboardEvent> = {},
      event: KeyboardEvent = key(name, overrides),
    ) => {
      let taken = false;
      act(() => {
        taken = result().handleSuggestionKeyDown(event);
      });
      return taken;
    },
    setPending: (isPending: boolean) => mount.rerender(tree(isPending)),
    /** Focus lands on the editor (or on `target`). */
    focusIn: (target: Element | undefined = dom) =>
      act(() => {
        target?.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      }),
    /** Focus leaves the editor for `relatedTarget` (null: nowhere). */
    focusOut: (relatedTarget: Element | null = null) =>
      act(() => {
        dom?.dispatchEvent(
          new FocusEvent("focusout", { bubbles: true, relatedTarget }),
        );
      }),
    inside,
    elsewhere,
    dom,
  };
}

const names = (picker: ReturnType<typeof setup>) =>
  picker.result().tagSuggestions.map((tag) => tag.name);

describe("the # picker's list", () => {
  it("has no six-row cap: a bare # lists every tag, most used first", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      name: `tag${String(index).padStart(2, "0")}`,
      count: index,
    }));
    const picker = setup({ tags: many });
    picker.type(0, "");
    expect(picker.result().showTagSuggestions).toBe(true);
    expect(picker.result().tagSuggestions).toHaveLength(40);
    expect(names(picker)[0]).toBe("tag39");
  });

  it("lists every match for typed text in the old exact, prefix, substring order", () => {
    const picker = setup();
    picker.type(0, "car");
    expect(names(picker)).toEqual(["carlsberg", "cargo"]);
  });

  it("hides when nothing matches", () => {
    const picker = setup();
    picker.type(0, "zzz");
    expect(picker.result().showTagSuggestions).toBe(false);
    expect(picker.press("Enter")).toBe(false);
  });

  it("hides while a send is in flight", () => {
    const picker = setup({ isPending: true });
    picker.type(0, "car");
    expect(picker.result().showTagSuggestions).toBe(false);
    expect(picker.press("Tab")).toBe(false);
  });
});

describe("highlight on typing", () => {
  it("highlights the first match at once once a name is typed", () => {
    const picker = setup();
    picker.type(4, "car");
    expect(picker.result().showTagSuggestions).toBe(true);
    expect(picker.result().activeTagIndex).toBe(0);
  });

  it("completes #car + Tab to #carlsberg and a space", () => {
    const picker = setup();
    picker.type(4, "car");
    expect(picker.press("Tab")).toBe(true);
    expect(picker.inserts).toEqual([
      {
        // From the "#" to the caret: 4, then "#car" is four characters long.
        range: { from: 4, to: 8 },
        content: { type: "text", text: "#carlsberg " },
      },
    ]);
  });

  it("completes on Enter the same way", () => {
    const picker = setup();
    picker.type(0, "ben");
    expect(picker.press("Enter")).toBe(true);
    expect(picker.inserts).toHaveLength(1);
    expect(picker.inserts[0]?.content).toEqual({
      type: "text",
      text: "#bender ",
    });
  });

  it("highlights nothing for a bare #, so Enter and Tab stay the editor's", () => {
    const picker = setup();
    picker.type(0, "");
    expect(picker.result().showTagSuggestions).toBe(true);
    expect(picker.result().activeTagIndex).toBe(-1);
    expect(picker.press("Enter")).toBe(false);
    expect(picker.press("Tab")).toBe(false);
    expect(picker.inserts).toEqual([]);
  });

  it("resets the highlight when the token changes", () => {
    const picker = setup();
    picker.type(0, "c");
    picker.press("ArrowDown");
    expect(picker.result().activeTagIndex).toBe(1);
    picker.type(0, "ca");
    expect(picker.result().activeTagIndex).toBe(0);
    // And back to the old token: still a fresh highlight, not the old pick.
    picker.press("ArrowDown");
    picker.type(0, "c");
    expect(picker.result().activeTagIndex).toBe(0);
  });
});

describe("arrows", () => {
  it("starts at the first row on ArrowDown from a bare #", () => {
    const picker = setup();
    picker.type(0, "");
    expect(picker.press("ArrowDown")).toBe(true);
    expect(picker.result().activeTagIndex).toBe(0);
    expect(picker.press("Enter")).toBe(true);
    expect(picker.inserts[0]?.content).toEqual({
      type: "text",
      text: "#bender ",
    });
  });

  it("starts at the last row on ArrowUp from a bare #", () => {
    const picker = setup();
    picker.type(0, "");
    picker.press("ArrowUp");
    expect(picker.result().activeTagIndex).toBe(3);
  });

  it("wraps around in both directions", () => {
    const picker = setup();
    picker.type(0, "");
    for (let step = 0; step < 4; step += 1) picker.press("ArrowDown");
    expect(picker.result().activeTagIndex).toBe(3);
    picker.press("ArrowDown");
    expect(picker.result().activeTagIndex).toBe(0);
    picker.press("ArrowUp");
    expect(picker.result().activeTagIndex).toBe(3);
  });

  it("completes the row the arrows reached", () => {
    const picker = setup();
    picker.type(0, "c");
    picker.press("ArrowDown");
    expect(picker.result().activeTagIndex).toBe(1);
    picker.press("Tab");
    expect(picker.inserts[0]?.content).toEqual({
      type: "text",
      text: "#cargo ",
    });
  });

  it("follows the mouse hovering a row", () => {
    const picker = setup();
    picker.type(0, "");
    act(() => picker.result().setActiveTagIndex(2));
    expect(picker.result().activeTagIndex).toBe(2);
    picker.press("Enter");
    expect(picker.inserts[0]?.content).toEqual({
      type: "text",
      text: "#cargo ",
    });
  });
});

describe("keys it must leave alone", () => {
  it("never takes Shift+Enter or Cmd/Ctrl+Enter, which send the note", () => {
    const picker = setup();
    picker.type(0, "car");
    expect(picker.press("Enter", { shiftKey: true })).toBe(false);
    expect(picker.press("Enter", { metaKey: true })).toBe(false);
    expect(picker.press("Enter", { ctrlKey: true })).toBe(false);
    expect(picker.press("Tab", { shiftKey: true })).toBe(false);
    expect(picker.press("ArrowDown", { altKey: true })).toBe(false);
    expect(picker.inserts).toEqual([]);
  });

  it("never takes a key during IME composition", () => {
    const picker = setup();
    picker.type(0, "car");
    expect(picker.press("Enter", { isComposing: true })).toBe(false);
    expect(picker.press("Enter", { keyCode: 229 })).toBe(false);
    expect(picker.press("ArrowDown", { isComposing: true })).toBe(false);
    expect(picker.press("Escape", { isComposing: true })).toBe(false);
    expect(picker.inserts).toEqual([]);
    expect(picker.result().showTagSuggestions).toBe(true);
  });

  it("takes nothing while no # token is under the caret", () => {
    const picker = setup();
    picker.clearToken();
    for (const name of ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"]) {
      expect(picker.press(name)).toBe(false);
    }
  });

  it("takes only the picker's own keys", () => {
    const picker = setup();
    picker.type(0, "car");
    for (const name of ["a", "Backspace", "ArrowLeft", " "]) {
      expect(picker.press(name)).toBe(false);
    }
  });
});

describe("Escape", () => {
  it("closes the list until the token changes", () => {
    const picker = setup();
    picker.type(0, "car");
    expect(picker.press("Escape")).toBe(true);
    expect(picker.result().showTagSuggestions).toBe(false);
    // Closed: keys are the editor's again.
    expect(picker.press("Enter")).toBe(false);

    picker.type(0, "carl");
    expect(picker.result().showTagSuggestions).toBe(true);
    expect(picker.result().activeTagIndex).toBe(0);
  });

  it("stays closed while the same token stays under the caret", () => {
    const picker = setup();
    picker.type(0, "car");
    picker.press("Escape");
    // The editor re-reports an identical token (a selection-only change).
    picker.type(0, "car");
    expect(picker.result().showTagSuggestions).toBe(false);
  });

  it("opens again after the caret leaves the token and comes back", () => {
    const picker = setup();
    picker.type(0, "car");
    picker.press("Escape");
    picker.clearToken();
    picker.type(0, "car");
    expect(picker.result().showTagSuggestions).toBe(true);
  });

  it("opens again when typing returns to the very token Escape closed", () => {
    const picker = setup();
    picker.type(0, "car");
    picker.press("Escape");
    picker.type(0, "carl");
    picker.type(0, "car");
    expect(picker.result().showTagSuggestions).toBe(true);
  });

  it("is also taken for a bare # with nothing highlighted", () => {
    const picker = setup();
    picker.type(0, "");
    expect(picker.press("Escape")).toBe(true);
    expect(picker.result().showTagSuggestions).toBe(false);
  });
});

describe("a dialog around the editor", () => {
  // What the dialog is told: the Escape keypress itself. ProseMirror prevents
  // the default of every Escape it sees, so `defaultPrevented` is true for all.
  const escapeKey = (event: KeyboardEvent = key("Escape")) => ({
    reason: "escape-key",
    event,
  });

  it("keeps its Escape from closing it while the list is open, and closes only the list", () => {
    const picker = setup();
    picker.type(0, "car");
    let claimed = false;
    act(() => {
      claimed = picker.result().claimDialogEscape(escapeKey());
    });
    expect(claimed).toBe(true);
    expect(picker.result().showTagSuggestions).toBe(false);
  });

  it("keeps the very Escape the editor already used to close the list", () => {
    const picker = setup();
    picker.type(0, "car");
    const keypress = key("Escape", { defaultPrevented: true });
    expect(picker.press("Escape", {}, keypress)).toBe(true);
    expect(picker.result().showTagSuggestions).toBe(false);
    expect(picker.result().claimDialogEscape(escapeKey(keypress))).toBe(true);
  });

  it("lets the next Escape close the dialog once the list is closed", () => {
    const picker = setup();
    picker.type(0, "car");
    picker.press("Escape");
    expect(picker.result().showTagSuggestions).toBe(false);
    // A second keypress: the list has nothing to do with it, even though
    // ProseMirror prevented its default like it does for every Escape.
    const next = key("Escape", { defaultPrevented: true });
    expect(picker.press("Escape", {}, next)).toBe(false);
    expect(picker.result().claimDialogEscape(escapeKey(next))).toBe(false);
  });

  it("lets the dialog close on an Escape the list has no use for", () => {
    const picker = setup();
    picker.type(0, "zzz");
    expect(picker.result().claimDialogEscape(escapeKey())).toBe(false);
    picker.clearToken();
    expect(picker.result().claimDialogEscape(escapeKey())).toBe(false);
  });

  it("lets the dialog close for any reason but the Escape key", () => {
    const picker = setup();
    picker.type(0, "car");
    expect(
      picker
        .result()
        .claimDialogEscape({ reason: "outside-press", event: {} as Event }),
    ).toBe(false);
    expect(picker.result().showTagSuggestions).toBe(true);
  });
});

describe("the list follows the editor's focus", () => {
  it("shows only while the editor has focus: click elsewhere and it goes", () => {
    const picker = setup({ withDom: true });
    picker.focusIn();
    picker.type(0, "car");
    expect(picker.result().showTagSuggestions).toBe(true);

    picker.focusOut();
    expect(picker.result().showTagSuggestions).toBe(false);
    // Nothing is listening for keys while the editor is not focused anyway,
    // but a stray one must not complete a tag.
    expect(picker.press("Tab")).toBe(false);
    expect(picker.inserts).toEqual([]);
  });

  it("comes back with the caret: focus the editor again and the same token is listed", () => {
    const picker = setup({ withDom: true });
    picker.type(0, "car");
    picker.focusOut();
    picker.focusIn();
    expect(picker.result().showTagSuggestions).toBe(true);
    expect(picker.result().activeTagIndex).toBe(0);
  });

  it("stays open while the focus moves around inside the editor", () => {
    const picker = setup({ withDom: true });
    picker.type(0, "car");
    picker.focusOut(picker.inside);
    expect(picker.result().showTagSuggestions).toBe(true);
    picker.focusIn(picker.inside);
    expect(picker.result().showTagSuggestions).toBe(true);
  });

  it("goes when the focus lands on something else", () => {
    const picker = setup({ withDom: true });
    picker.type(0, "car");
    picker.focusIn(picker.elsewhere);
    expect(picker.result().showTagSuggestions).toBe(false);
    picker.focusIn();
    expect(picker.result().showTagSuggestions).toBe(true);
  });

  it("goes when the focus leaves for another element", () => {
    const picker = setup({ withDom: true });
    picker.type(0, "car");
    picker.focusOut(picker.elsewhere);
    expect(picker.result().showTagSuggestions).toBe(false);
  });

  it("does not undo an Escape when the focus returns", () => {
    const picker = setup({ withDom: true });
    picker.type(0, "car");
    picker.press("Escape");
    picker.focusOut();
    picker.focusIn();
    // Escape closed this token's list; leaving and returning does not undo it.
    expect(picker.result().showTagSuggestions).toBe(false);
    picker.type(0, "carl");
    expect(picker.result().showTagSuggestions).toBe(true);
  });

  it("stays hidden for a token in an editor that was never focused, such as a draft restored on load", () => {
    const picker = setup({ focused: false });
    picker.type(0, "car");
    expect(picker.result().showTagSuggestions).toBe(false);
    picker.focusIn();
    expect(picker.result().showTagSuggestions).toBe(true);
  });

  it("is up at once when the editor already has the focus as the hook mounts, like the canvas's", () => {
    const picker = setup({ focused: true });
    picker.type(0, "car");
    expect(picker.result().showTagSuggestions).toBe(true);
  });

  it("stays hidden while there is no mounted editor to ask", () => {
    const picker = setup({ withDom: false });
    picker.type(0, "car");
    expect(picker.result().showTagSuggestions).toBe(false);
    expect(picker.press("Tab")).toBe(false);
  });
});

describe("editorElement", () => {
  it("is the editor's DOM node once mounted", () => {
    const dom = document.createElement("div");
    expect(editorElement({ view: { dom } } as unknown as Editor)).toBe(dom);
  });

  it("is null without an editor, or before TipTap has a view (it throws then)", () => {
    expect(editorElement(null)).toBeNull();
    expect(editorElement(undefined)).toBeNull();
    const unmounted = {
      get view(): never {
        throw new Error("the editor view is not available");
      },
    } as unknown as Editor;
    expect(editorElement(unmounted)).toBeNull();
  });
});
