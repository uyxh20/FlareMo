import { useQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { type RefObject, useState } from "react";
import { listMemos, type Memo } from "@/api";
import { FORK_TAG_PICKER_LIMIT } from "@/fork/tag-picker";
import { type TagPicker, useTagPicker } from "@/fork/use-tag-picker";
import {
  filterTagSuggestions,
  type TagSuggestion,
} from "@/lib/tag-autocomplete";

type UseComposerSuggestionsOptions = {
  editorRef: RefObject<Editor | null>;
  isPending: boolean;
  /** Known tags with usage counts, powering the "#" autocomplete. */
  tags?: TagSuggestion[];
};

export type UseComposerSuggestionsResult = {
  /** Token under the caret, fed straight back into the editor prop. */
  setActiveTagToken: (token: { from: number; text: string } | null) => void;
  /** Token under the caret, fed straight back into the editor prop. */
  setActiveWikiToken: (token: { from: number; query: string } | null) => void;
  tagSuggestions: TagSuggestion[];
  showTagSuggestions: boolean;
  /**
   * The "#" list's highlight, keys and Escape (fork add-on, see
   * docs/fork-customizations.md).
   */
  activeTagIndex: TagPicker["activeIndex"];
  setActiveTagIndex: TagPicker["setActiveIndex"];
  handleSuggestionKeyDown: TagPicker["onKeyDown"];
  claimDialogEscape: TagPicker["claimDialogEscape"];
  acceptTagSuggestion: (name: string) => void;
  wikiSuggestions: Memo[];
  showWikiSuggestions: boolean;
  acceptWikiSuggestion: (targetMemo: Memo) => void;
};

/**
 * The composer's two inline autocompletes. "#" matches the instance's known
 * tags locally; "[[" asks the memo list (5s stale time) for the highlighted
 * note. Both rewrite the in-progress token in place and each keeps its own
 * token state, since only one of them can be under the caret at a time.
 */
export function useComposerSuggestions({
  editorRef,
  isPending,
  tags,
}: UseComposerSuggestionsOptions): UseComposerSuggestionsResult {
  // "#" autocomplete: the in-progress tag token under the caret (reported by
  // the editor's transactions) plus the highlighted row.
  const [activeTagToken, setActiveTagToken] = useState<{
    from: number;
    text: string;
  } | null>(null);
  // "[[" autocomplete: in-progress wikilink token under the caret
  const [activeWikiToken, setActiveWikiToken] = useState<{
    from: number;
    query: string;
  } | null>(null);

  const wikiSuggestionsQuery = useQuery({
    queryKey: ["composer-wiki-suggestions", activeWikiToken?.query],
    queryFn: ({ signal }) =>
      listMemos(
        { q: activeWikiToken?.query?.trim() || undefined, page_size: 5 },
        signal,
      ),
    enabled: Boolean(activeWikiToken),
    staleTime: 5000,
  });

  const tagSuggestions =
    tags && activeTagToken
      ? filterTagSuggestions(tags, activeTagToken.text, FORK_TAG_PICKER_LIMIT)
      : [];
  const showTagSuggestions = tagSuggestions.length > 0 && !isPending;

  const acceptTagSuggestion = (name: string) => {
    if (!activeTagToken) return;
    const editor = editorRef.current;
    if (!editor) return;
    const caret = activeTagToken.from + 1 + activeTagToken.text.length;
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: activeTagToken.from, to: caret },
        { type: "text", text: `#${name} ` },
      )
      .run();
  };

  const tagPicker = useTagPicker({
    token: activeTagToken,
    suggestions: tagSuggestions,
    enabled: showTagSuggestions,
    onAccept: acceptTagSuggestion,
    getEditor: () => editorRef.current,
  });

  const wikiSuggestions = wikiSuggestionsQuery.data?.memos ?? [];
  const showWikiSuggestions =
    Boolean(activeWikiToken) && wikiSuggestions.length > 0 && !isPending;

  const acceptWikiSuggestion = (targetMemo: Memo) => {
    if (!activeWikiToken) return;
    const editor = editorRef.current;
    if (!editor) return;
    const title =
      targetMemo.content
        .split("\n")[0]
        ?.replace(/[#*`]/g, "")
        .trim()
        .slice(0, 30) || targetMemo.id;
    const linkText = `[${title}](/memo/${targetMemo.id}) `;
    const caret = activeWikiToken.from + 2 + activeWikiToken.query.length;
    editor
      .chain()
      .focus()
      .insertContentAt(
        { from: activeWikiToken.from, to: caret },
        { type: "text", text: linkText },
      )
      .run();
    setActiveWikiToken(null);
  };

  return {
    setActiveTagToken,
    setActiveWikiToken,
    tagSuggestions,
    showTagSuggestions: tagPicker.open,
    activeTagIndex: tagPicker.activeIndex,
    setActiveTagIndex: tagPicker.setActiveIndex,
    handleSuggestionKeyDown: tagPicker.onKeyDown,
    claimDialogEscape: tagPicker.claimDialogEscape,
    acceptTagSuggestion,
    wikiSuggestions,
    showWikiSuggestions,
    acceptWikiSuggestion,
  };
}
