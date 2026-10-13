import { useMemo } from "react";
import type { Attachment, Memo } from "@/api";
import { AttachmentGallery } from "@/components/attachment-gallery";
import { LazyMemoContent } from "@/components/lazy-memo-content";
import { MemoSearchExcerpt } from "@/components/memo-search-excerpt";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n";
import {
  createImageDimensionResolver,
  filterUnreferencedAttachments,
} from "@/lib/attachment-refs";
import { extractTags } from "@/lib/memo";
import { countTaskItems } from "@/lib/memo-tasks";
import { cn } from "@/lib/utils";
import { stateLabel } from "./memo-card-badges";
import type { MemoTaskInteraction } from "./use-memo-card-actions";

/** Bodies beyond this size collapse in the timeline. */
const COLLAPSE_THRESHOLD = 600;

type MemoCardBodyProps = {
  attachments: Attachment[];
  canManage: boolean;
  /** Expansion survives an edit round-trip, so the card holds it. */
  expanded: boolean;
  memo: Memo;
  onTagClick?: (tag: string) => void;
  onToggleExpanded: () => void;
  searchQuery?: string;
  taskInteraction?: MemoTaskInteraction;
};

/** The card's read face: the body, its collapse control and the tag footer. */
export function MemoCardBody({
  attachments,
  canManage,
  expanded,
  memo,
  onTagClick,
  onToggleExpanded,
  searchQuery,
  taskInteraction,
}: MemoCardBodyProps) {
  const { t } = useI18n();
  const tags = memo.payload.tags ?? extractTags(memo.content);
  // Body-referenced images render inline; the gallery keeps only the rest.
  const galleryAttachments = filterUnreferencedAttachments(
    attachments,
    memo.content,
  );
  // Long bodies (transcripts, articles) collapse so one memo cannot dominate
  // the timeline.
  const isCollapsible =
    memo.content.length > COLLAPSE_THRESHOLD ||
    memo.content.split("\n").length > 12;
  const collapsed = isCollapsible && !expanded;
  // Intrinsic boxes for body images: uploaded dimensions ride the
  // attachments list, so a photo the author placed inline never shoves the
  // cards below it aside while loading.
  const resolveImageDimensions = useMemo(
    () => createImageDimensionResolver(attachments),
    [attachments],
  );
  const taskCount = useMemo(() => countTaskItems(memo.content), [memo.content]);

  return (
    <>
      <div>
        <div className="relative">
          <div
            className={cn(
              "overflow-hidden motion-safe:transition-[max-height] motion-safe:duration-250 motion-safe:ease-signal",
              // Fork: no cap once expanded, so a long memo is never cut off
              // (docs/fork-customizations.md).
              collapsed ? "max-h-52" : "max-h-none",
            )}
          >
            <LazyMemoContent
              content={memo.content}
              interactiveTaskLists={canManage && taskCount > 0}
              resolveImageDimensions={resolveImageDimensions}
              onToggleTask={taskInteraction?.onToggleTask}
              onConvertTask={taskInteraction?.onConvertTask}
            />
          </div>
          <div
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-card to-transparent motion-safe:transition-opacity motion-safe:duration-200",
              collapsed ? "opacity-100" : "opacity-0",
            )}
          />
        </div>
        {isCollapsible && (
          <Button
            className="mt-1.5"
            onClick={onToggleExpanded}
            size="sm"
            variant="ghost"
          >
            {collapsed ? t("reading.expand") : t("reading.collapse")}
          </Button>
        )}
        {searchQuery && (
          <MemoSearchExcerpt content={memo.content} query={searchQuery} />
        )}
        {galleryAttachments.length > 0 && (
          <div className="mt-3">
            <AttachmentGallery attachments={galleryAttachments} />
          </div>
        )}
      </div>
      {(tags.length > 0 || memo.state !== "normal") && (
        <footer className="flex flex-wrap items-center justify-between gap-2 pt-1">
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) =>
              onTagClick ? (
                <button
                  aria-label={`#${tag}`}
                  className="cursor-pointer rounded-full motion-safe:transition-transform motion-safe:duration-150 motion-safe:hover:-translate-y-px"
                  key={tag}
                  type="button"
                  onClick={() => onTagClick(tag)}
                >
                  <Badge
                    className="transition-colors hover:bg-brand-200 dark:hover:bg-brand-400/20"
                    variant="brand"
                  >
                    #{tag}
                  </Badge>
                </button>
              ) : (
                <Badge key={tag} variant="brand">
                  #{tag}
                </Badge>
              ),
            )}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {memo.state !== "normal" && (
              <Badge variant="outline">{stateLabel(memo.state, t)}</Badge>
            )}
          </div>
        </footer>
      )}
    </>
  );
}
