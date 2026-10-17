import { plannerSummaryMemoTag } from "@flaremo/contracts";
import { XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { plannerWeekNumber } from "./goals-model";
import type { PlannerGoalsStrings } from "./goals-strings";
import { PlannerBadge } from "./goals-ui";
import { PlannerMarkdown } from "./review-markdown";

// The summary memo sheet of the weekly review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): the memo as it streams in, with Stop
// while the model writes, then Edit, Write again, Copy markdown and Save. The
// memo is saved to the owner's memos only when they press Save, so they can
// edit it first; the text they save is what is kept. After that the main
// button is Look forward, until the memo is edited again.

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
  name,
  memo,
  live,
  memoBy,
  stopped,
  waitingForAgent = false,
  canWriteAgain,
  saved,
  saving,
  saveFailed,
  strings,
  onClose,
  onStop,
  onWriteAgain,
  onEdit,
  onSave,
  onLookForward,
}: {
  open: boolean;
  /** The Monday of the week the memo is about. */
  week: string;
  /** The memo's name in place of the week's ("October 2026"), for a period. */
  name?: string;
  memo: string | null;
  /** The text so far while the model writes, else null. */
  live: string | null;
  memoBy: "model" | "page" | null;
  stopped: boolean;
  /** The memo agent is reading the week; its memo arrives whole. */
  waitingForAgent?: boolean;
  canWriteAgain: boolean;
  /** The memo as shown is the one saved in the owner's memos. */
  saved: boolean;
  saving: boolean;
  saveFailed: boolean;
  strings: PlannerGoalsStrings;
  onClose: () => void;
  onStop: () => void;
  onWriteAgain: () => void;
  /** The owner changed the text. */
  onEdit: (memo: string) => void;
  onSave: () => void;
  onLookForward: () => void;
}) {
  const text = strings.review.memo;
  const streaming = live !== null;
  const markdown = live ?? memo ?? "";
  const weekName = name ?? strings.week(plannerWeekNumber(week));
  const [editing, setEditing] = useState(false);

  // A new memo starts in the preview.
  useEffect(() => {
    if (streaming || !open) setEditing(false);
  }, [streaming, open]);

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
        className="top-3 flex max-h-[calc(100dvh-1.5rem)] w-[min(820px,calc(100%-1rem))] max-w-none translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:top-6 sm:max-h-[calc(100dvh-3rem)] sm:max-w-none"
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
                {canWriteAgain && !editing && (
                  <Button size="sm" variant="outline" onClick={onWriteAgain}>
                    {text.writeAgain}
                  </Button>
                )}
                <Button
                  data-testid="planner-memo-edit"
                  disabled={!memo}
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing((now) => !now)}
                >
                  {editing ? text.preview : text.edit}
                </Button>
                {!editing && (
                  <Button
                    disabled={!markdown}
                    size="sm"
                    variant="outline"
                    onClick={() => void copy()}
                  >
                    {text.copy}
                  </Button>
                )}
                {saved ? (
                  <Button
                    disabled={saving || !memo}
                    size="sm"
                    onClick={onLookForward}
                  >
                    {strings.review.toLookForward}
                  </Button>
                ) : (
                  <Button
                    data-testid="planner-memo-save"
                    disabled={saving || !memo?.trim()}
                    size="sm"
                    onClick={() => {
                      setEditing(false);
                      onSave();
                    }}
                  >
                    {saving ? text.saving : saveFailed ? text.retry : text.save}
                  </Button>
                )}
              </>
            )}
          </div>
        </div>
        {!streaming && memo && !saved && (
          <p
            className="border-b border-border px-4 py-2 text-xs text-muted-foreground"
            data-testid="planner-memo-unsaved"
          >
            {text.unsavedHint}
          </p>
        )}
        <div className="min-h-40 overflow-y-auto px-[18px] pt-4 pb-6 sm:px-7 sm:pt-5 sm:pb-7">
          {editing && !streaming ? (
            <Textarea
              aria-label={text.editLabel}
              autoFocus
              className="min-h-[50dvh] font-mono text-[13px] leading-relaxed md:text-[13px]"
              data-testid="planner-memo-editor"
              value={memo ?? ""}
              onChange={(event) => onEdit(event.target.value)}
            />
          ) : markdown ? (
            <PlannerMarkdown
              diaryLabel={(from, to) => text.diary(dayRange(from, to, strings))}
              live={streaming}
              markdown={markdown}
            />
          ) : (
            <span className="planner-thinking text-sm text-muted-foreground">
              {waitingForAgent ? text.writingAgent : text.writing}
            </span>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
