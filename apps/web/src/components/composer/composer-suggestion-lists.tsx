import { Link2Icon } from "lucide-react";
import type { Memo } from "@/api";
import { pointerTravelled, type TagPickerAnchor } from "@/fork/tag-picker";
import { useTagPickerList } from "@/fork/use-tag-picker-list";
import { useI18n } from "@/i18n";
import type { TagSuggestion } from "@/lib/tag-autocomplete";
import { cn } from "@/lib/utils";

/**
 * "#tag" autocomplete rows. The list is a plain (non-focusable) overlay: the
 * buttons keep the editor selection on mousedown so the picked tag rewrites
 * the token that opened the list. The editor keeps the keyboard; the list only
 * shows which row the arrows (or the pointer) have reached. Fork additions
 * (docs/fork-customizations.md): the whole list scrolls, a highlighted row,
 * and placement that keeps it on screen.
 */
export function ComposerTagSuggestions({
  visible,
  suggestions,
  onAccept,
  activeIndex = -1,
  onActiveIndexChange,
  anchor = "composer",
}: {
  visible: boolean;
  suggestions: TagSuggestion[];
  onAccept: (name: string) => void;
  /** Highlighted row (-1 for none). */
  activeIndex?: number;
  /** The pointer reached another row. */
  onActiveIndexChange?: (index: number) => void;
  /** Where the list hangs: the timeline composer, or the focus canvas. */
  anchor?: TagPickerAnchor;
}) {
  const { t } = useI18n();
  const { listRef, positionClass, style } = useTagPickerList({
    visible,
    anchor,
    suggestions,
    activeIndex,
  });
  if (!visible) return null;
  return (
    <div
      aria-label={t("explorer.tags")}
      className={cn(
        "absolute inset-x-4 z-30 max-h-72 overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover p-1 shadow-md motion-safe:animate-rise",
        positionClass,
      )}
      data-testid="composer-tag-suggestions"
      ref={listRef}
      role="listbox"
      style={style}
      // Not even its scrollbar may take focus from the editor.
      onMouseDown={(event) => event.preventDefault()}
    >
      {suggestions.map((suggestion, index) => (
        <button
          aria-selected={index === activeIndex}
          className={cn(
            "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-left text-sm motion-safe:transition-colors",
            index === activeIndex
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
          )}
          key={suggestion.name}
          role="option"
          tabIndex={-1}
          type="button"
          onMouseDown={(event) => {
            // Keep editor focus/selection so the rewritten caret lands.
            event.preventDefault();
            onAccept(suggestion.name);
          }}
          onMouseMove={(event) => {
            if (index !== activeIndex && pointerTravelled(event)) {
              onActiveIndexChange?.(index);
            }
          }}
        >
          <span className="truncate">
            <span className="text-muted-foreground">#</span>
            {suggestion.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {suggestion.count}
          </span>
        </button>
      ))}
    </div>
  );
}

/**
 * "[[" wikilink autocomplete rows: the note's first line as the link title,
 * with its date on the right. Same mousedown contract as the tag list.
 */
export function ComposerWikiSuggestions({
  visible,
  suggestions,
  onAccept,
}: {
  visible: boolean;
  suggestions: Memo[];
  onAccept: (memo: Memo) => void;
}) {
  if (!visible) return null;
  return (
    <div
      className="absolute inset-x-4 bottom-12 z-30 max-h-56 overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-md motion-safe:animate-rise divide-y divide-border/20"
      data-testid="composer-wikilink-suggestions"
    >
      {suggestions.map((memo) => {
        const preview = memo.content.split("\n")[0]?.slice(0, 50) || memo.id;
        return (
          <button
            className="flex w-full items-center justify-between gap-3 px-3.5 py-2 text-left text-sm text-muted-foreground motion-safe:transition-colors hover:bg-muted/60 hover:text-foreground cursor-pointer"
            key={memo.name}
            type="button"
            onMouseDown={(event) => {
              event.preventDefault();
              onAccept(memo);
            }}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Link2Icon className="size-3.5 shrink-0 text-primary" />
              <span className="truncate font-medium text-foreground text-xs">
                {preview}
              </span>
            </div>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {(memo.display_time ?? memo.create_time)?.slice(0, 10)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
