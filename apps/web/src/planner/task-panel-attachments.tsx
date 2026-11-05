import {
  type PlannerAgentActionDto,
  type PlannerAttachmentDto,
  plannerAttachmentsPerTask,
} from "@flaremo/contracts";
import { Loader2Icon, XIcon } from "lucide-react";
import {
  type DragEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
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
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/i18n";
import { cn, formatBytes } from "@/lib/utils";
import { MORE_BUTTON_CLASS } from "@/pages/projects/constants";
import { plannerAttachmentIsImage } from "./api";
import { PlannerProposalCard, usePlannerAskCopy } from "./ask-chat";
import { usePlannerStrings } from "./strings";
import {
  plannerAttachmentState,
  usePlannerAttachmentActions,
} from "./use-attachment-actions";

export { plannerAttachmentState } from "./use-attachment-actions";

// The task's files (fork-owned add-on, docs/fork-task-attachments.md): a
// screenshot, a PDF, an email, anything up to 10 MB (audio and video 95 MB) and 10 a task. Files
// arrive by drop on the section, by paste while the panel is open (unless a
// text box has the focus) or from the file picker, and upload one at a time
// so the task's room is checked in order. Each shows its name (a link that
// opens it), a picture or its type, its size and its state in plain words. A
// file is removed after a confirmation; the server keeps it a week.
//
// Once stored, a file is read into a proposed comment (phase 2): the state
// reads "reading…" while the server works (the panel asks again every few
// seconds), then the card shows under the file with Accept and Dismiss. "Read"
// or "Read again" asks for a read; the switch at the bottom keeps the task's
// files stored only.
//
// The list is part of the task's detail (`detail.attachments`), so an upload
// adds to the cached detail and a removal takes from it; a failure puts the
// detail back by asking the server again, and says why in a toast.

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

/** Whether a Read (again) button makes sense for the file. */
function canRead(attachment: PlannerAttachmentDto): boolean {
  switch (attachment.read_state) {
    case "stored":
    case "failed":
    case "capped":
    case "skipped":
      return true;
    case "read":
      return (
        attachment.proposal?.state === "dismissed" ||
        attachment.proposal?.state === "expired"
      );
    default:
      return false;
  }
}

/** Whether a paste should go to the task's files: not while a text box has the focus. */
function pasteIsForFiles(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true;
  const tag = target.tagName;
  return !(tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable);
}

// --- One file -----------------------------------------------------------------

function AttachmentItem({
  attachment,
  readsEnabled,
  today,
  onRemove,
  onRead,
  onSettled,
}: {
  attachment: PlannerAttachmentDto;
  readsEnabled: boolean;
  today: string;
  onRemove: (attachment: PlannerAttachmentDto) => void;
  onRead: (attachment: PlannerAttachmentDto) => void;
  onSettled: (attachmentId: string, action: PlannerAgentActionDto) => void;
}) {
  const strings = usePlannerStrings();
  const askCopy = usePlannerAskCopy();
  const copy = strings.panel.attachments;
  const kind = plannerAttachmentKind(attachment);
  const state = plannerAttachmentState(attachment, copy);
  const readable = readsEnabled && canRead(attachment);

  return (
    <li
      className="group flex flex-col gap-2"
      data-state={attachment.read_state}
      data-testid="planner-attachment"
    >
      <div className="flex items-center gap-3">
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
          <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            {attachment.read_state === "pending" && (
              <Loader2Icon className="size-3 shrink-0 animate-spin" />
            )}
            <span className="truncate">
              {kind} · {formatBytes(attachment.size)} · {state}
            </span>
          </span>
        </div>
        {readable && (
          <Button
            size="xs"
            type="button"
            variant="ghost"
            onClick={() => onRead(attachment)}
          >
            {attachment.read_state === "stored" ? copy.read : copy.readAgain}
          </Button>
        )}
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
      </div>
      {attachment.proposal && (
        <div className="pl-13">
          <PlannerProposalCard
            action={attachment.proposal}
            copy={askCopy}
            task={attachment.task_id}
            today={today}
            onSettled={(action) => onSettled(attachment.id, action)}
          />
        </div>
      )}
    </li>
  );
}

// --- The section --------------------------------------------------------------

export function PlannerTaskAttachments({
  taskId,
  attachments,
  filesRead,
  readsEnabled,
  today,
}: {
  taskId: string;
  attachments: readonly PlannerAttachmentDto[];
  /** False when the task is set to store files without reading them. */
  filesRead: boolean;
  /** Whether this deployment reads files at all (the agent is set up). */
  readsEnabled: boolean;
  today: string;
}) {
  const strings = usePlannerStrings();
  const { t } = useI18n();
  const copy = strings.panel.attachments;
  const headingId = useId();
  const switchId = useId();
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

  // While a file is being read, the detail is asked for every few seconds.
  const reading = attachments.some((entry) => entry.read_state === "pending");
  useEffect(() => {
    if (!reading) return;
    const timer = window.setInterval(actions.poll, 3000);
    return () => window.clearInterval(timer);
  }, [reading, actions]);

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
              readsEnabled={readsEnabled}
              today={today}
              onRead={actions.read}
              onRemove={setRemoving}
              onSettled={actions.settled}
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
      {readsEnabled && (
        <div className="flex items-center justify-between gap-3 text-sm">
          <label className="text-muted-foreground" htmlFor={switchId}>
            {copy.storeOnly}
          </label>
          <Switch
            checked={!filesRead}
            data-testid="planner-attachments-store-only"
            id={switchId}
            onCheckedChange={(checked) => void actions.setFilesRead(!checked)}
          />
        </div>
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
