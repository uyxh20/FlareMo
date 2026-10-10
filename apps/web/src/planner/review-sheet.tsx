import { plannerSummaryMemoTag } from "@flaremo/contracts";
import { XIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { plannerWeekNumber } from "./goals-model";
import type { PlannerGoalsStrings } from "./goals-strings";
import { PlannerBadge } from "./goals-ui";
import { PlannerMarkdown } from "./review-markdown";

// The summary memo sheet of the weekly review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): the memo as it streams in, with Stop
// while the model writes, then Write again, Copy markdown and Look forward. The
// memo is saved to the owner's memos as soon as it is finished.

/** "5 – 11 Oct" from two days written YYYY-MM-DD. */
function dayRange(from: string, to: string, strings: PlannerGoalsStrings) {
  const part = (day: string) => ({
    month: Number(day.slice(5, 7)) - 1,
    day: Number(day.slice(8, 10)),
  });
  return strings.range(part(from), part(to));
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Some embedded browsers block the clipboard API; a selected textarea
    // still copies there.
  }
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function PlannerMemoSheet({
  open,
  week,
  memo,
  live,
  memoBy,
  stopped,
  canWriteAgain,
  saving,
  saveFailed,
  strings,
  onClose,
  onStop,
  onWriteAgain,
  onRetrySave,
  onLookForward,
}: {
  open: boolean;
  /** The Monday of the week the memo is about. */
  week: string;
  memo: string | null;
  /** The text so far while the model writes, else null. */
  live: string | null;
  memoBy: "model" | "page" | null;
  stopped: boolean;
  canWriteAgain: boolean;
  saving: boolean;
  saveFailed: boolean;
  strings: PlannerGoalsStrings;
  onClose: () => void;
  onStop: () => void;
  onWriteAgain: () => void;
  onRetrySave: () => void;
  onLookForward: () => void;
}) {
  const text = strings.review.memo;
  const streaming = live !== null;
  const markdown = live ?? memo ?? "";
  const weekName = strings.week(plannerWeekNumber(week));

  const copy = async () => {
    if (await copyText(markdown)) toast.success(text.copied);
    else toast.error(text.copyBlocked);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        aria-label={text.label(weekName)}
        className="top-3 flex max-h-[calc(100dvh-1.5rem)] w-[min(760px,calc(100%-1rem))] max-w-none translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:top-6 sm:max-h-[calc(100dvh-3rem)] sm:max-w-none"
        data-testid="planner-memo-sheet"
        showCloseButton={false}
      >
        <div className="flex flex-wrap items-center gap-2.5 border-b border-border px-4 py-3">
          <DialogTitle className="text-sm font-semibold">
            {text.title(weekName)}
          </DialogTitle>
          <PlannerBadge className="max-sm:hidden">
            {plannerSummaryMemoTag}
          </PlannerBadge>
          {!streaming && memoBy === "page" && (
            <PlannerBadge className="max-sm:hidden">
              {text.template}
            </PlannerBadge>
          )}
          {!streaming && stopped && memoBy === "model" && (
            <PlannerBadge className="max-sm:hidden">
              {text.stopped}
            </PlannerBadge>
          )}
          <DialogClose
            render={
              <Button
                aria-label={text.close}
                className="ml-auto sm:order-last sm:ml-0"
                size="icon-sm"
                variant="ghost"
              >
                <XIcon />
              </Button>
            }
          />
          <div className="flex flex-wrap items-center justify-end gap-2 max-sm:w-full sm:ml-auto">
            {streaming ? (
              <Button size="sm" variant="outline" onClick={onStop}>
                {text.stop}
              </Button>
            ) : (
              <>
                {canWriteAgain && (
                  <Button size="sm" variant="outline" onClick={onWriteAgain}>
                    {text.writeAgain}
                  </Button>
                )}
                {saveFailed && !saving && (
                  <Button size="sm" variant="outline" onClick={onRetrySave}>
                    {text.retry}
                  </Button>
                )}
                <Button
                  disabled={!markdown}
                  size="sm"
                  variant="outline"
                  onClick={() => void copy()}
                >
                  {text.copy}
                </Button>
                <Button
                  disabled={saving || !memo}
                  size="sm"
                  onClick={onLookForward}
                >
                  {saving ? text.saving : strings.review.toLookForward}
                </Button>
              </>
            )}
          </div>
        </div>
        <div className="min-h-40 overflow-y-auto px-[18px] pt-4 pb-6 sm:px-7 sm:pt-5 sm:pb-7">
          {markdown ? (
            <PlannerMarkdown
              diaryLabel={(from, to) => text.diary(dayRange(from, to, strings))}
              live={streaming}
              markdown={markdown}
            />
          ) : (
            <span className="planner-thinking text-sm text-muted-foreground">
              {text.writing}
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
