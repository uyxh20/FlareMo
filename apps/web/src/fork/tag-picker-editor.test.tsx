// @vitest-environment jsdom
import type { Editor } from "@tiptap/react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichComposerEditor } from "@/components/rich-composer-editor";
import { type ForkTestMount, forkTestMount } from "./test-render";

// The editor's side of the "#" picker: onSuggestionKeyDown is the first look
// at every keydown, ahead of the editor's own Enter/Escape/Backspace handling,
// and never during IME composition.

let mounted: ForkTestMount | undefined;

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

function mountEditor(
  props: {
    onSuggestionKeyDown?: (event: KeyboardEvent) => boolean;
    submitOnEnter?: boolean;
  } = {},
) {
  const onSubmitRequest = vi.fn();
  const editorRef: { current: Editor | null } = { current: null };
  mounted = forkTestMount(
    <RichComposerEditor
      ariaLabel="New note"
      content=""
      disabled={false}
      editorRef={editorRef}
      onContentChange={() => undefined}
      onImageFiles={() => undefined}
      onSubmitRequest={onSubmitRequest}
      placeholder=""
      {...props}
    />,
  );
  const dom = mounted.container.querySelector<HTMLElement>(
    '[contenteditable="true"]',
  );
  if (!dom) throw new Error("the editor did not mount");
  return {
    onSubmitRequest,
    /** A keydown on the editor; returns it so the test can read the outcome. */
    press: (key: string, init: KeyboardEventInit = {}) => {
      const event = new KeyboardEvent("keydown", {
        key,
        bubbles: true,
        cancelable: true,
        ...init,
      });
      act(() => {
        dom.dispatchEvent(event);
      });
      return event;
    },
  };
}

describe("RichComposerEditor onSuggestionKeyDown", () => {
  it("is offered keys the editor itself never looks at: the arrows and Tab", () => {
    const seen: string[] = [];
    const editor = mountEditor({
      onSuggestionKeyDown: (event) => {
        seen.push(event.key);
        return false;
      },
    });
    for (const key of ["ArrowDown", "ArrowUp", "Tab", "a"]) editor.press(key);
    expect(seen).toEqual(["ArrowDown", "ArrowUp", "Tab", "a"]);
  });

  it("is offered Enter and Escape too, before the editor's own handling", () => {
    const seen: string[] = [];
    const editor = mountEditor({
      onSuggestionKeyDown: (event) => {
        seen.push(event.key);
        return false;
      },
    });
    editor.press("Enter");
    editor.press("Escape");
    expect(seen).toEqual(["Enter", "Escape"]);
  });

  it("takes the key when it returns true: the editor then does nothing else with it", () => {
    const editor = mountEditor({ onSuggestionKeyDown: () => true });
    // Ctrl+Enter is the editor's send chord; a taken key must not send.
    const event = editor.press("Enter", { ctrlKey: true });
    expect(editor.onSubmitRequest).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves the key to the editor when it returns false", () => {
    const editor = mountEditor({ onSuggestionKeyDown: () => false });
    editor.press("Enter", { ctrlKey: true });
    expect(editor.onSubmitRequest).toHaveBeenCalledTimes(1);
    editor.press("Enter", { shiftKey: true });
    expect(editor.onSubmitRequest).toHaveBeenCalledTimes(2);
  });

  it("changes nothing when there is no callback: Shift+Enter still sends", () => {
    const editor = mountEditor();
    editor.press("ArrowDown");
    editor.press("Tab");
    editor.press("Enter", { shiftKey: true });
    expect(editor.onSubmitRequest).toHaveBeenCalledTimes(1);
  });

  it("is not offered a key during IME composition", () => {
    const onSuggestionKeyDown = vi.fn(() => true);
    const editor = mountEditor({ onSuggestionKeyDown });
    editor.press("Enter", { isComposing: true });
    editor.press("ArrowDown", { isComposing: true });
    editor.press("Enter", { keyCode: 229 });
    editor.press("Process", { keyCode: 229 });
    expect(onSuggestionKeyDown).not.toHaveBeenCalled();
  });

  it("reads the latest callback, not the first one", () => {
    const first = vi.fn(() => false);
    const second = vi.fn(() => false);
    const editor = mountEditor({ onSuggestionKeyDown: first });
    editor.press("ArrowDown");
    mounted?.rerender(
      <RichComposerEditor
        ariaLabel="New note"
        content=""
        disabled={false}
        editorRef={{ current: null }}
        onContentChange={() => undefined}
        onImageFiles={() => undefined}
        onSubmitRequest={() => undefined}
        onSuggestionKeyDown={second}
        placeholder=""
      />,
    );
    editor.press("ArrowDown");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });
});
