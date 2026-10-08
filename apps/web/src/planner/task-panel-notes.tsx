import type { PlannerTaskDetailResponse } from "@flaremo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { CheckIcon, Loader2Icon } from "lucide-react";
import { type RefObject, useId, useLayoutEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/query-keys";
import { plannerErrorMessage, plannerUpdateTaskRequest } from "./api";
import { plannerDetailWithAnswer } from "./panel-model";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";
import { plannerToastId } from "./use-planner-actions";
import { usePlannerAutosave } from "./use-planner-autosave";

// The task's notes (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): upstream's own
// `notes` field, in a text box that grows with what is typed. It saves by itself,
// about 800 ms after typing stops (at most every 5 s), when the box loses focus and
// when the page is hidden or closed (see use-planner-autosave.ts), and says so
// quietly: "Saving…", then "Saved". A save that fails keeps the text, says
// "Couldn't save" with a Retry, and toasts.

/** The most upstream stores in a task's notes. */
const NOTES_MAX = 20_000;

/**
 * Makes a textarea as tall as its text, so a note never scrolls inside its own
 * box. `field-sizing: content` would do it, but not every browser has it yet.
 */
export function usePlannerAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `value` is what resizes it
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, [ref, value]);
}

export function PlannerTaskNotes({
  taskId,
  today,
  notes,
}: {
  taskId: string;
  today: string;
  /** The notes the server has: the box follows them while nothing here is unsaved. */
  notes: string | null;
}) {
  const strings = usePlannerStrings();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const headingId = useId();

  const autosave = usePlannerAutosave({
    saved: notes ?? "",
    save: async (value, { keepalive }) => {
      try {
        const input = {
          today,
          // Empty notes are none, as upstream stores them.
          notes: value.trim() === "" ? null : value,
        };
        // A save made as the page is hidden or closed asks to outlive the page
        // (api.ts sends it that way when the body is small enough).
        const response = await (keepalive
          ? plannerUpdateTaskRequest(taskId, input, { keepalive: true })
          : plannerUpdateTaskRequest(taskId, input));
        queryClient.setQueryData<PlannerTaskDetailResponse>(
          plannerQueryKeys.detail(taskId),
          (detail) =>
            detail ? plannerDetailWithAnswer(detail, response) : detail,
        );
        // Upstream's own task lists show notes too, and the archive has a new
        // "Edited" line. The board shows neither, so it is left alone.
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
        void queryClient.invalidateQueries({
          queryKey: plannerQueryKeys.history(taskId),
        });
      } catch (error) {
        toast.error(
          plannerErrorMessage(
            error,
            strings.toast.notesFailed,
            strings.toast.rateLimited,
          ),
          { id: plannerToastId },
        );
        // The autosave keeps the text and shows "Couldn't save".
        throw error;
      }
    },
  });
  usePlannerAutoGrow(textareaRef, autosave.value);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3
          className="text-xs font-medium text-muted-foreground"
          id={headingId}
        >
          {strings.panel.notes.title}
        </h3>
        <p
          aria-live="polite"
          className="flex min-h-5 items-center gap-1 text-xs text-muted-foreground"
          data-testid="planner-notes-status"
        >
          {autosave.status === "saving" && (
            <>
              <Loader2Icon className="size-3 motion-safe:animate-spin" />
              {strings.panel.notes.saving}
            </>
          )}
          {autosave.status === "saved" && (
            <>
              <CheckIcon className="size-3" />
              {strings.panel.notes.saved}
            </>
          )}
          {autosave.status === "error" && (
            <>
              <span className="text-destructive">
                {strings.panel.notes.failed}
              </span>
              <Button
                className="h-5 px-1.5 text-xs"
                size="xs"
                type="button"
                variant="ghost"
                onClick={autosave.retry}
              >
                {strings.panel.notes.retry}
              </Button>
            </>
          )}
        </p>
      </div>
      <Textarea
        aria-labelledby={headingId}
        className="field-sizing-fixed min-h-24 resize-none overflow-hidden border-transparent bg-transparent px-2 leading-relaxed hover:bg-muted/60 focus-visible:bg-transparent md:text-sm dark:bg-transparent dark:hover:bg-muted/40"
        maxLength={NOTES_MAX}
        placeholder={strings.panel.notes.placeholder}
        ref={textareaRef}
        value={autosave.value}
        onBlur={autosave.onBlur}
        onChange={(event) => autosave.onChange(event.target.value)}
      />
    </section>
  );
}
