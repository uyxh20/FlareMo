import {
  type PlannerAttachmentDto,
  type PlannerTaskDetailResponse,
  plannerAttachmentMaxBytes,
  plannerAttachmentsPerTask,
} from "@flaremo/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2Icon, XIcon } from "lucide-react";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { useI18n } from "@/i18n";
import { cn, formatBytes } from "@/lib/utils";
import { MORE_BUTTON_CLASS } from "@/pages/projects/constants";
import {
  plannerAttachmentIsImage,
  plannerDeleteAttachmentRequest,
  plannerErrorMessage,
  plannerUploadAttachmentRequest,
} from "./api";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";
import { plannerToastId } from "./use-planner-actions";

// The task's files (fork-owned add-on, docs/fork-task-attachments.md): a
// screenshot, a PDF, an email, anything up to 10 MB and 10 a task. Files
// arrive by drop on the section, by paste while the panel is open (unless a
// text box has the focus) or from the file picker, and upload one at a time
// so the task's room is checked in order. Each shows its name (a link that
// opens it), a picture or its type, its size and its state in plain words. A
// file is removed after a confirmation; the server keeps it a week.
//
// The list is part of the task's detail (`detail.attachments`), so an upload
// adds to the cached detail and a removal takes from it; a failure puts the
// detail back by asking the server again, and says why in a toast.

type Detail = PlannerTaskDetailResponse;

/** A file on its way up: shown dimmed at the end of the list. */
type Uploading = { key: number; name: string; size: number };

/** The file's type in one word: the extension when there is one, else from the MIME type. */
export function plannerAttachmentKind(attachment: {
  filename: string;
  content_type: string | null;
}): string {
  const dot = attachment.filename.lastIndexOf(".");
  const extension =
    dot > 0 && dot < attachment.filename.length - 1
      ? attachment.filename.slice(dot + 1)
      : "";
  if (extension && extension.length <= 5) return extension.toUpperCase();
  const type = attachment.content_type ?? "";
  if (type.startsWith("image/")) return "IMAGE";
  if (type.startsWith("text/")) return "TEXT";
  if (type === "application/pdf") return "PDF";
  return "FILE";
}

/** Whether a paste should go to the task's files: not while a text box has the focus. */
function pasteIsForFiles(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  const tag = target.tagName;
  return !(tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable);
}

function usePlannerAttachmentActions(taskId: string) {
  const queryClient = useQueryClient();
  const strings = usePlannerStrings();
  const stringsRef = useRef(strings);
  stringsRef.current = strings;
  const [uploading, setUploading] = useState<Uploading[]>([]);
  const serial = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());

  const actions = useMemo(() => {
    const detailKey = plannerQueryKeys.detail(taskId);
    const current = () => queryClient.getQueryData<Detail>(detailKey);
    const setDetail = (update: (detail: Detail) => Detail) =>
      queryClient.setQueryData<Detail>(detailKey, (detail) =>
        detail ? update(detail) : detail,
      );
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: detailKey });
      void queryClient.invalidateQueries({
        queryKey: plannerQueryKeys.history(taskId),
      });
    };
    const fail = (error: unknown, fallback: string) =>
      toast.error(
        plannerErrorMessage(
          error,
          fallback,
          stringsRef.current.toast.rateLimited,
        ),
        { id: plannerToastId },
      );

    const uploadOne = async (file: File, key: number) => {
      try {
        const { attachment } = await plannerUploadAttachmentRequest(
          taskId,
          file,
        );
        setDetail((detail) => ({
          ...detail,
          attachments: [...detail.attachments, attachment],
        }));
        void queryClient.invalidateQueries({
          queryKey: plannerQueryKeys.history(taskId),
        });
      } catch (error) {
        fail(error, stringsRef.current.toast.attachmentUploadFailed);
      } finally {
        setUploading((list) => list.filter((entry) => entry.key !== key));
      }
    };

    return {
      /** Checks each file here first, then uploads them one after another. */
      add: (files: readonly File[]) => {
        const copy = stringsRef.current.panel.attachments;
        const held = current()?.attachments.length ?? 0;
        let queued = 0;
        setUploading((list) => {
          queued = list.length;
          return list;
        });
        const accepted: { file: File; key: number }[] = [];
        for (const file of files) {
          if (file.size > plannerAttachmentMaxBytes) {
            toast.error(
              copy.tooLarge(file.name, formatBytes(plannerAttachmentMaxBytes)),
              { id: plannerToastId },
            );
            continue;
          }
          if (held + queued + accepted.length >= plannerAttachmentsPerTask) {
            toast.error(copy.tooMany(plannerAttachmentsPerTask), {
              id: plannerToastId,
            });
            break;
          }
          serial.current += 1;
          accepted.push({ file, key: serial.current });
        }
        if (accepted.length === 0) return;
        setUploading((list) => [
          ...list,
          ...accepted.map(({ file, key }) => ({
            key,
            name: file.name,
            size: file.size,
          })),
        ]);
        for (const { file, key } of accepted) {
          queue.current = queue.current.then(() => uploadOne(file, key));
        }
      },

      remove: async (attachment: PlannerAttachmentDto) => {
        setDetail((detail) => ({
          ...detail,
          attachments: detail.attachments.filter(
            (entry) => entry.id !== attachment.id,
          ),
        }));
        try {
          await plannerDeleteAttachmentRequest(attachment.id);
          void queryClient.invalidateQueries({
            queryKey: plannerQueryKeys.history(taskId),
          });
        } catch (error) {
          refresh();
          fail(error, stringsRef.current.toast.attachmentRemoveFailed);
        }
      },
    };
  }, [queryClient, taskId]);

  return { actions, uploading };
}

// --- One file -----------------------------------------------------------------

function AttachmentItem({
  attachment,
  onRemove,
}: {
  attachment: PlannerAttachmentDto;
  onRemove: (attachment: PlannerAttachmentDto) => void;
}) {
  const strings = usePlannerStrings();
  const copy = strings.panel.attachments;
  const kind = plannerAttachmentKind(attachment);
  const state =
    attachment.read_state === "stored" ? copy.stored : attachment.read_state;

  return (
    <li
      className="group flex items-center gap-3"
      data-testid="planner-attachment"
    >
      <a
        className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted/40 text-[11px] font-medium text-muted-foreground"
        href={attachment.url}
        rel="noreferrer"
        tabIndex={-1}
        target="_blank"
      >
        {plannerAttachmentIsImage(attachment) ? (
          <img
            alt=""
            className="size-full object-cover"
            loading="lazy"
            src={attachment.url}
          />
        ) : (
          kind
        )}
      </a>
      <div className="flex min-w-0 flex-1 flex-col">
        <a
          className="truncate text-sm font-medium hover:underline"
          href={attachment.url}
          rel="noreferrer"
          target="_blank"
          title={copy.open}
        >
          {attachment.filename}
        </a>
        <span className="truncate text-xs text-muted-foreground">
          {kind} · {formatBytes(attachment.size)} · {state}
        </span>
      </div>
      <Button
        aria-label={copy.remove}
        className={MORE_BUTTON_CLASS}
        size="icon-xs"
        title={copy.remove}
        type="button"
        variant="ghost"
        onClick={() => onRemove(attachment)}
      >
        <XIcon />
      </Button>
    </li>
  );
}

// --- The section --------------------------------------------------------------

export function PlannerTaskAttachments({
  taskId,
  attachments,
}: {
  taskId: string;
  attachments: readonly PlannerAttachmentDto[];
}) {
  const strings = usePlannerStrings();
  const { t } = useI18n();
  const copy = strings.panel.attachments;
  const headingId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const { actions, uploading } = usePlannerAttachmentActions(taskId);
  const [removing, setRemoving] = useState<PlannerAttachmentDto | null>(null);
  const [over, setOver] = useState(false);

  const onDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      setOver(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) actions.add(files);
    },
    [actions],
  );

  // A paste anywhere in the page while the panel is open, unless a text box has
  // the focus (a note or a comment keeps its own paste).
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      if (!pasteIsForFiles(event.target)) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      actions.add(files);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [actions]);

  const count = attachments.length + uploading.length;
  const full = count >= plannerAttachmentsPerTask;

  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3"
      data-testid="planner-attachments"
      onDragLeave={() => setOver(false)}
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDrop={onDrop}
    >
      <h3 className="text-xs font-medium text-muted-foreground" id={headingId}>
        {copy.title}
        {count > 0 && (
          <span className="ml-1.5 tabular-nums">
            {copy.count(count, plannerAttachmentsPerTask)}
          </span>
        )}
      </h3>
      {count === 0 ? (
        <p className="text-sm text-muted-foreground">{copy.empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {attachments.map((attachment) => (
            <AttachmentItem
              attachment={attachment}
              key={attachment.id}
              onRemove={setRemoving}
            />
          ))}
          {uploading.map((entry) => (
            <li
              aria-busy="true"
              className="flex items-center gap-3 opacity-60"
              data-testid="planner-attachment-uploading"
              key={entry.key}
            >
              <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border bg-muted/40">
                <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
              </span>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {entry.name}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {formatBytes(entry.size)} · {copy.uploading}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {!full && (
        <p
          className={cn(
            "rounded-lg border border-border px-3 py-2 text-center text-sm text-muted-foreground",
            over && "border-foreground bg-muted/60",
          )}
        >
          {copy.drop}{" "}
          <button
            className="font-medium text-foreground underline-offset-2 hover:underline"
            type="button"
            onClick={() => inputRef.current?.click()}
          >
            {copy.choose}
          </button>
        </p>
      )}
      <input
        aria-label={copy.choose}
        className="sr-only"
        data-testid="planner-attachment-input"
        multiple
        ref={inputRef}
        tabIndex={-1}
        type="file"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) actions.add(files);
        }}
      />

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy.removeTitle}</AlertDialogTitle>
            <AlertDialogDescription>{copy.removeBody}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) void actions.remove(removing);
              }}
            >
              {copy.removeConfirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
