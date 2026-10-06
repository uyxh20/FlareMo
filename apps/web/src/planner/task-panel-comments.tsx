import type {
  PlannerCommentDto,
  PlannerTaskDetailResponse,
} from "@flaremo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { PencilIcon, SendHorizontalIcon, Trash2Icon } from "lucide-react";
import { useCallback, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useI18n } from "@/i18n";
import { formatDateTime } from "@/lib/date-format";
import { cn } from "@/lib/utils";
import { MORE_BUTTON_CLASS } from "@/pages/projects/constants";
import {
  plannerAddCommentRequest,
  plannerDeleteCommentRequest,
  plannerErrorMessage,
  plannerUpdateCommentRequest,
} from "./api";
import { plannerRelativeTime } from "./dates";
import {
  plannerDetailReplacingComment,
  plannerDetailWithComment,
  plannerDetailWithoutComment,
  plannerIsPendingComment,
  plannerPendingCommentId,
} from "./panel-model";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";
import { usePlannerAutoGrow } from "./task-panel-notes";
import { plannerToastId } from "./use-planner-actions";

// The task's comments (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): oldest first, each
// with its text, "You", and how long ago, the exact time on hover. A comment can be
// edited in place and deleted after a confirmation. The box at the bottom sends on
// Enter and adds a line on Shift+Enter.
//
// Changes are optimistic, in the panel's cached detail: a new comment shows at
// once, dimmed, until the server's copy replaces it; an edit and a delete show at
// once too. A failure puts things back and says why in a toast (and a new
// comment's text returns to the box, so nothing typed is lost).

type Detail = PlannerTaskDetailResponse;

/** Adds, edits and deletes comments on one task, optimistically. */
function usePlannerCommentActions(taskId: string) {
  const queryClient = useQueryClient();
  const strings = usePlannerStrings();
  const stringsRef = useRef(strings);
  stringsRef.current = strings;
  const serial = useRef(0);

  return useMemo(() => {
    const detailKey = plannerQueryKeys.detail(taskId);
    const patch = (change: (detail: Detail) => Detail) => {
      queryClient.setQueryData<Detail>(detailKey, (detail) =>
        detail ? change(detail) : detail,
      );
    };
    const current = () => queryClient.getQueryData<Detail>(detailKey);
    // Each change adds a line to the task's history; if it is open it refreshes.
    const refreshHistory = () =>
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.history(taskId),
      });
    const fail = (error: unknown, fallback: string) =>
      toast.error(
        plannerErrorMessage(
          error,
          fallback,
          stringsRef.current.toast.rateLimited,
        ),
        { id: plannerToastId },
      );

    return {
      /** Resolves true when the comment was added, so the box can empty. */
      add: async (body: string): Promise<boolean> => {
        serial.current += 1;
        const pendingId = plannerPendingCommentId(serial.current);
        const at = new Date().toISOString();
        await queryClient.cancelQueries({ queryKey: detailKey });
        patch((detail) =>
          plannerDetailWithComment(detail, {
            id: pendingId,
            task_id: taskId,
            body: body.trim(),
            created_at: at,
            updated_at: at,
          }),
        );
        try {
          const { comment } = await plannerAddCommentRequest(taskId, body);
          patch((detail) =>
            plannerDetailReplacingComment(detail, pendingId, comment),
          );
          refreshHistory();
          return true;
        } catch (error) {
          patch((detail) => plannerDetailWithoutComment(detail, pendingId));
          fail(error, stringsRef.current.toast.commentAddFailed);
          return false;
        }
      },

      edit: async (commentId: string, body: string): Promise<boolean> => {
        const before = current()?.comments.find(
          (comment) => comment.id === commentId,
        );
        if (!before) return false;
        await queryClient.cancelQueries({ queryKey: detailKey });
        patch((detail) =>
          plannerDetailReplacingComment(detail, commentId, {
            ...before,
            body: body.trim(),
            updated_at: new Date().toISOString(),
          }),
        );
        try {
          const { comment } = await plannerUpdateCommentRequest(
            commentId,
            body,
          );
          patch((detail) =>
            plannerDetailReplacingComment(detail, commentId, comment),
          );
          refreshHistory();
          return true;
        } catch (error) {
          patch((detail) =>
            plannerDetailReplacingComment(detail, commentId, before),
          );
          fail(error, stringsRef.current.toast.commentEditFailed);
          return false;
        }
      },

      remove: async (commentId: string): Promise<void> => {
        const comments = current()?.comments ?? [];
        const index = comments.findIndex((comment) => comment.id === commentId);
        const before = comments[index];
        if (!before) return;
        await queryClient.cancelQueries({ queryKey: detailKey });
        patch((detail) => plannerDetailWithoutComment(detail, commentId));
        try {
          await plannerDeleteCommentRequest(commentId);
          refreshHistory();
        } catch (error) {
          // Back where it was, not at the end: the list is oldest first.
          patch((detail) => {
            const restored = [...detail.comments];
            restored.splice(Math.min(index, restored.length), 0, before);
            return { ...detail, comments: restored };
          });
          fail(error, stringsRef.current.toast.commentDeleteFailed);
        }
      },
    };
  }, [queryClient, taskId]);
}

/** Whether an Enter key press should send: Enter alone, and not one that confirms an IME candidate. */
function isSendKey(event: React.KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    !event.shiftKey &&
    !event.nativeEvent.isComposing &&
    event.keyCode !== 229
  );
}

// --- One comment --------------------------------------------------------------

function CommentItem({
  comment,
  onDelete,
  onSave,
}: {
  comment: PlannerCommentDto;
  /** Asks to delete this comment (the section confirms). */
  onDelete: (comment: PlannerCommentDto) => void;
  /** Saves new text; resolves true when it was saved. */
  onSave: (comment: PlannerCommentDto, body: string) => Promise<boolean>;
}) {
  const strings = usePlannerStrings();
  const { t } = useI18n();
  const copy = strings.panel.comments;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const waiting = plannerIsPendingComment(comment);
  const edited = comment.updated_at > comment.created_at;
  const exact = formatDateTime(comment.created_at, strings.intlLocale);
  usePlannerAutoGrow(textareaRef, editing ? draft : "");

  const startEditing = () => {
    setDraft(comment.body);
    setEditing(true);
    // After the textarea has mounted.
    requestAnimationFrame(() => {
      const field = textareaRef.current;
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
    });
  };
  const save = () => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    if (text !== comment.body.trim()) void onSave(comment, text);
  };

  return (
    <li
      aria-busy={waiting || undefined}
      className={cn("group flex flex-col gap-1", waiting && "opacity-60")}
      data-testid="planner-comment"
    >
      <div className="flex min-h-7 items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{copy.you}</span>
        <span aria-hidden="true">·</span>
        <Tooltip>
          <TooltipTrigger
            className="cursor-default"
            render={<time dateTime={comment.created_at} />}
          >
            {plannerRelativeTime(
              comment.created_at,
              Date.now(),
              strings.intlLocale,
            )}
            <span className="sr-only"> ({exact})</span>
          </TooltipTrigger>
          <TooltipContent>{exact}</TooltipContent>
        </Tooltip>
        {edited && !waiting && (
          <>
            <span aria-hidden="true">·</span>
            <span>{copy.edited}</span>
          </>
        )}
        {!waiting && !editing && (
          <span className="ml-auto flex items-center gap-0.5">
            <Button
              aria-label={copy.edit}
              className={MORE_BUTTON_CLASS}
              size="icon-xs"
              title={copy.edit}
              type="button"
              variant="ghost"
              onClick={startEditing}
            >
              <PencilIcon />
            </Button>
            <Button
              aria-label={copy.remove}
              className={MORE_BUTTON_CLASS}
              size="icon-xs"
              title={copy.remove}
              type="button"
              variant="ghost"
              onClick={() => onDelete(comment)}
            >
              <Trash2Icon />
            </Button>
          </span>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label={copy.edit}
            className="field-sizing-fixed min-h-16 resize-none overflow-hidden"
            maxLength={5000}
            ref={textareaRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (isSendKey(event)) {
                event.preventDefault();
                save();
              } else if (event.key === "Escape") {
                // Cancel the edit, not the panel behind it.
                event.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              type="button"
              variant="ghost"
              onClick={() => setEditing(false)}
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={draft.trim() === ""}
              size="sm"
              type="button"
              onClick={save}
            >
              {copy.save}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
          {comment.body}
        </p>
      )}
    </li>
  );
}

// --- The new comment box ------------------------------------------------------

function CommentComposer({
  onSubmit,
}: {
  /** Adds the comment; resolves true when it was added. */
  onSubmit: (body: string) => Promise<boolean>;
}) {
  const strings = usePlannerStrings();
  const copy = strings.panel.comments;
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hintId = useId();
  usePlannerAutoGrow(textareaRef, text);

  const submit = () => {
    const body = text.trim();
    if (!body) return;
    setText("");
    textareaRef.current?.focus();
    void onSubmit(body).then((added) => {
      // Not added: the text comes back, unless something new was typed meanwhile.
      if (!added) setText((current) => (current === "" ? body : current));
    });
  };

  return (
    <div className="flex items-end gap-2">
      <Textarea
        aria-describedby={hintId}
        aria-label={copy.label}
        className="field-sizing-fixed max-h-48 min-h-9 resize-none py-1.5"
        enterKeyHint="send"
        maxLength={5000}
        placeholder={copy.placeholder}
        ref={textareaRef}
        rows={1}
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (isSendKey(event)) {
            event.preventDefault();
            submit();
          }
        }}
      />
      <span className="sr-only" id={hintId}>
        {copy.hint}
      </span>
      <Button
        aria-label={copy.send}
        disabled={text.trim() === ""}
        size="icon"
        title={`${copy.send} · ${copy.hint}`}
        type="button"
        onClick={submit}
      >
        <SendHorizontalIcon />
      </Button>
    </div>
  );
}

// --- The section --------------------------------------------------------------

export function PlannerTaskComments({
  taskId,
  comments,
}: {
  taskId: string;
  comments: readonly PlannerCommentDto[];
}) {
  const strings = usePlannerStrings();
  const { t } = useI18n();
  const copy = strings.panel.comments;
  const headingId = useId();
  const actions = usePlannerCommentActions(taskId);
  const [deleting, setDeleting] = useState<PlannerCommentDto | null>(null);
  const askToDelete = useCallback(
    (comment: PlannerCommentDto) => setDeleting(comment),
    [],
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 className="text-xs font-medium text-muted-foreground" id={headingId}>
        {copy.title}
        {comments.length > 0 && (
          <span className="ml-1.5 tabular-nums">{comments.length}</span>
        )}
      </h3>
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.empty}</p>
      ) : (
        <ul className="flex flex-col gap-4" data-testid="planner-comments">
          {comments.map((comment) => (
            <CommentItem
              comment={comment}
              key={comment.id}
              onDelete={askToDelete}
              onSave={(entry, body) => actions.edit(entry.id, body)}
            />
          ))}
        </ul>
      )}
      <CommentComposer onSubmit={actions.add} />

      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.deleteTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.deleteBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (deleting) void actions.remove(deleting.id);
              }}
            >
              {copy.deleteConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
