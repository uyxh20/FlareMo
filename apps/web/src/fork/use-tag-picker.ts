import type { Editor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import type { TagSuggestion } from "@/lib/tag-autocomplete";
import {
  defaultTagPickerIndex,
  shouldClaimDialogEscape,
  tagPickerKeyAction,
} from "./tag-picker";

// Fork-owned (docs/fork-customizations.md): the state behind the "#" tag
// picker's keyboard support. useComposerSuggestions calls it once per composer
// and passes what it returns on, so the upstream hook only wires it in.

export type TagPickerToken = { from: number; text: string };

export type UseTagPickerOptions = {
  /** The "#" token under the caret, as the editor reports it. */
  token: TagPickerToken | null;
  /** The matches for that token, best first. */
  suggestions: TagSuggestion[];
  /** False while nothing should show: no matches, or a send in flight. */
  enabled: boolean;
  /** Complete the token with this tag. */
  onAccept: (name: string) => void;
  /**
   * The editor the token is in. The list shows only while that editor has
   * focus: click elsewhere and it goes, with the caret that opened it. With no
   * editor to ask (none mounted yet, or none given) it stays hidden.
   */
  getEditor?: () => Editor | null | undefined;
};

/**
 * The editor's DOM node, or null before it is mounted (TipTap throws when
 * `view` is read until then).
 */
export function editorElement(
  editor: Pick<Editor, "view"> | null | undefined,
): Element | null {
  try {
    return editor?.view.dom ?? null;
  } catch {
    return null;
  }
}

export type TagPicker = {
  /** The list is on screen: it has matches and Escape has not closed it. */
  open: boolean;
  /** Highlighted row, -1 for none. */
  activeIndex: number;
  /** Move the highlight (the mouse hovering a row). */
  setActiveIndex: (index: number) => void;
  /**
   * The editor's first look at every keydown. True means the picker used the
   * key, so the editor must do nothing else with it.
   */
  onKeyDown: (event: KeyboardEvent) => boolean;
  /**
   * For a dialog's `onOpenChange`: true means this Escape belongs to the list,
   * so the dialog must stay open (the list is closed here if it was still open).
   */
  claimDialogEscape: (details: { reason: string; event: Event }) => boolean;
};

/** What the person did to the list while the caret stayed in one token. */
type TokenSession = {
  tokenKey: string;
  /** Row chosen with the arrows or the mouse; null until one is. */
  picked: number | null;
  /** Escape closed the list. */
  dismissed: boolean;
};

/**
 * Highlight, dismissal and key handling of the picker.
 *
 * Both are remembered per token and forgotten the moment the token changes: a
 * token the person is still typing gets its best match highlighted afresh, and
 * Escape hides the list only until the token changes (typing on, or moving the
 * caret away and back, brings it back).
 */
export function useTagPicker({
  token,
  suggestions,
  enabled,
  onAccept,
  getEditor,
}: UseTagPickerOptions): TagPicker {
  const tokenKey = token ? `${token.from}:${token.text}` : null;
  const [session, setSession] = useState<TokenSession | null>(null);
  const current =
    tokenKey !== null && session?.tokenKey === tokenKey ? session : null;

  // Focus decides whether the list is up, not just the token: the token stays
  // in the editor after the caret leaves it (the editor reports nothing on
  // blur), the editor can be given a token without ever being focused (a draft
  // restored on load), and with the focus canvas open both composers hold the
  // same draft.
  const getEditorRef = useRef(getEditor);
  getEditorRef.current = getEditor;
  const [editorFocused, setEditorFocused] = useState(false);
  useEffect(() => {
    const inEditor = (node: EventTarget | null) => {
      const element = editorElement(getEditorRef.current?.());
      return element !== null && node instanceof Node && element.contains(node);
    };
    // The focus canvas focuses its editor before this effect runs, so look
    // where the focus already is.
    setEditorFocused(inEditor(document.activeElement));
    const focusedIn = (event: FocusEvent) =>
      setEditorFocused(inEditor(event.target));
    // `relatedTarget` is where the focus goes (null: nowhere, or the window).
    const focusedOut = (event: FocusEvent) =>
      setEditorFocused(inEditor(event.relatedTarget));
    document.addEventListener("focusin", focusedIn);
    document.addEventListener("focusout", focusedOut);
    return () => {
      document.removeEventListener("focusin", focusedIn);
      document.removeEventListener("focusout", focusedOut);
    };
  }, []);

  const picked = current?.picked ?? null;
  const open =
    enabled &&
    editorFocused &&
    token !== null &&
    suggestions.length > 0 &&
    !(current?.dismissed ?? false);
  // The list can shrink under a picked row (the tag list refreshed), so clamp.
  const activeIndex =
    open && token
      ? picked !== null
        ? Math.min(picked, suggestions.length - 1)
        : defaultTagPickerIndex(token.text)
      : -1;

  // A session belongs to one token; drop it as soon as the token is another.
  useEffect(() => {
    if (session && session.tokenKey !== tokenKey) setSession(null);
  }, [session, tokenKey]);

  // The Escape keypress that closed the list, so a dialog that hears the same
  // keypress next can tell it was already used.
  const closedBy = useRef<Event | null>(null);

  const remember = (patch: Partial<Omit<TokenSession, "tokenKey">>) => {
    if (tokenKey === null) return;
    setSession((previous) => ({
      picked: null,
      dismissed: false,
      ...(previous?.tokenKey === tokenKey ? previous : null),
      ...patch,
      tokenKey,
    }));
  };

  const onKeyDown = (event: KeyboardEvent): boolean => {
    const action = tagPickerKeyAction(
      { open, count: suggestions.length, activeIndex },
      event,
    );
    switch (action.type) {
      case "move":
        remember({ picked: action.index });
        return true;
      case "accept": {
        const suggestion = suggestions[action.index];
        if (!suggestion) return false;
        onAccept(suggestion.name);
        return true;
      }
      case "close":
        closedBy.current = event;
        remember({ dismissed: true });
        return true;
      default:
        return false;
    }
  };

  const claimDialogEscape = (details: { reason: string; event: Event }) => {
    const claimed = shouldClaimDialogEscape({
      open,
      reason: details.reason,
      usedByList: details.event === closedBy.current,
    });
    if (claimed && open) remember({ dismissed: true });
    return claimed;
  };

  return {
    open,
    activeIndex,
    setActiveIndex: (index) => remember({ picked: index }),
    onKeyDown,
    claimDialogEscape,
  };
}
