import { useQueryClient } from "@tanstack/react-query";
import {
  BoldIcon,
  CheckIcon,
  Heading2Icon,
  ListIcon,
  ListTodoIcon,
  Loader2Icon,
  PencilIcon,
} from "lucide-react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { queryKeys } from "@/lib/query-keys";
import { plannerErrorMessage, plannerUpdateTaskRequest } from "./api";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";
import { PlannerTaskMarkdown } from "./task-markdown";
import { plannerStoreFor, plannerToastId } from "./use-planner-actions";
import { usePlannerAutosave } from "./use-planner-autosave";

// The task's notes (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): upstream's own
// `notes` field, in a text box that grows with what is typed. It saves by itself,
// about 800 ms after typing stops (at most every 5 s), when the box loses focus and
// when the page is hidden or closed (see use-planner-autosave.ts), and says so
// quietly: "Saving…", then "Saved". A save that fails keeps the text, says
// "Couldn't save" with a Retry, and toasts.
//
// Notes read as Markdown (task-markdown.tsx): the panel opens on the drawn note,
// whose to-do boxes can be ticked there (the line is rewritten and saved at
// once). A click on the text or Edit opens the plain box, with a small toolbar;
// Done, Esc or clicking away goes back. Empty notes show the box straight away.

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
  aside,
}: {
  taskId: string;
  today: string;
  /** The notes the server has: the box follows them while nothing here is unsaved. */
  notes: string | null;
  /** Something for the heading row, before the save status: the panel's "Ask agent". */
  aside?: ReactNode;
}) {
  const strings = usePlannerStrings();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const headingId = useId();

  const autosave = usePlannerAutosave({
    saved: notes ?? "",
    save: async (value, { keepalive }) => {
      // The box holds the text while it saves, so nothing shows early; the saved
      // notes go into the task's one copy (task-store.ts) when the server has
      // them, and only the notes: a notes save never rewrites another field.
      const change = plannerStoreFor(queryClient).begin(taskId, {
        refresh: false,
      });
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
        change.saved({
          detail: (detail) => ({
            ...detail,
            task: {
              ...detail.task,
              notes: response.task.notes,
              updated_at: response.task.updated_at,
            },
          }),
        });
        // Upstream's own task lists show notes too, and the archive has a new
        // "Edited" line. The board shows neither, so it is left alone.
        void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
        void queryClient.invalidateQueries({
          queryKey: plannerQueryKeys.history(taskId),
        });
      } catch (error) {
        change.failed();
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
  const [editing, setEditing] = useState(false);
  const empty = autosave.value.trim() === "";
  const showBox = editing || empty;
  usePlannerAutoGrow(textareaRef, showBox ? autosave.value : "");

  // Opening the box puts the cursor at the end of the text.
  useEffect(() => {
    if (!editing) return;
    const field = textareaRef.current;
    if (!field || document.activeElement === field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, [editing]);

  const startEditing = () => {
    // Selecting text to copy it is not asking to edit.
    if (window.getSelection()?.toString()) return;
    setEditing(true);
  };
  const stopEditing = () => {
    autosave.onBlur();
    setEditing(false);
  };
  const toggle = (next: string) => {
    autosave.onChange(next);
    // A tick is a finished edit: save it now, like a blur.
    autosave.onBlur();
  };
  /** A toolbar button: changes the box's text and keeps the cursor in it. */
  const apply = (
    edit: (
      value: string,
      start: number,
      end: number,
    ) => { value: string; start: number; end: number },
  ) => {
    const field = textareaRef.current;
    if (!field) return;
    const result = edit(field.value, field.selectionStart, field.selectionEnd);
    autosave.onChange(result.value);
    requestAnimationFrame(() => {
      field.focus();
      field.setSelectionRange(result.start, result.end);
    });
  };
  const startLine = (prefix: string) =>
    apply((value, start, end) => {
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      return {
        value: value.slice(0, lineStart) + prefix + value.slice(lineStart),
        start: start + prefix.length,
        end: end + prefix.length,
      };
    });
  const wrap = (mark: string) =>
    apply((value, start, end) => ({
      value:
        value.slice(0, start) +
        mark +
        value.slice(start, end) +
        mark +
        value.slice(end),
      start: start + mark.length,
      end: end + mark.length,
    }));
  const tools = [
    {
      label: strings.panel.notes.todo,
      icon: <ListTodoIcon />,
      run: () => startLine("- [ ] "),
    },
    {
      label: strings.panel.notes.heading,
      icon: <Heading2Icon />,
      run: () => startLine("## "),
    },
    {
      label: strings.panel.notes.list,
      icon: <ListIcon />,
      run: () => startLine("- "),
    },
    {
      label: strings.panel.notes.bold,
      icon: <BoldIcon />,
      run: () => wrap("**"),
    },
  ];

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3
          className="text-xs font-medium text-muted-foreground"
          id={headingId}
        >
          {strings.panel.notes.title}
        </h3>
        {aside && <div className="ml-auto">{aside}</div>}
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
        {!empty &&
          (editing ? (
            <Button
              className="h-6 px-2 text-xs"
              size="xs"
              type="button"
              variant="outline"
              onClick={stopEditing}
              onMouseDown={(event) => event.preventDefault()}
            >
              {strings.panel.notes.done}
            </Button>
          ) : (
            <Button
              aria-label={strings.panel.notes.edit}
              className="h-6 px-2 text-xs"
              size="xs"
              title={strings.panel.notes.edit}
              type="button"
              variant="ghost"
              onClick={() => setEditing(true)}
            >
              <PencilIcon className="size-3" />
              {strings.panel.notes.editShort}
            </Button>
          ))}
      </div>
      {!showBox && (
        // A click on the text opens the box; the Edit button is the keyboard's way in.
        // biome-ignore lint/a11y/noStaticElementInteractions: the Edit button is the accessible control
        // biome-ignore lint/a11y/useKeyWithClickEvents: the Edit button is the accessible control
        <div
          className="-mx-0 cursor-text rounded-md px-2 py-1.5 hover:bg-muted/60 dark:hover:bg-muted/40"
          data-testid="planner-notes-view"
          onClick={(event) => {
            if ((event.target as HTMLElement).closest("a, input, button")) {
              return;
            }
            startEditing();
          }}
        >
          <PlannerTaskMarkdown onToggle={toggle} text={autosave.value} title />
        </div>
      )}
      {showBox && editing && (
        <div
          aria-label={strings.panel.notes.toolbar}
          className="flex flex-wrap gap-1"
          role="toolbar"
        >
          {tools.map((tool) => (
            <Button
              aria-label={tool.label}
              className="h-6 gap-1 px-1.5 text-xs text-muted-foreground"
              key={tool.label}
              size="xs"
              title={tool.label}
              type="button"
              variant="ghost"
              // Keeps the cursor in the box, so it does not close.
              onMouseDown={(event) => event.preventDefault()}
              onClick={tool.run}
            >
              {tool.icon}
              {tool.label}
            </Button>
          ))}
        </div>
      )}
      {showBox && (
        <Textarea
          aria-labelledby={headingId}
          className="field-sizing-fixed min-h-24 resize-none overflow-hidden border-transparent bg-transparent px-2 leading-relaxed hover:bg-muted/60 focus-visible:bg-transparent md:text-sm dark:bg-transparent dark:hover:bg-muted/40"
          maxLength={NOTES_MAX}
          placeholder={strings.panel.notes.placeholder}
          ref={textareaRef}
          value={autosave.value}
          onBlur={stopEditing}
          onChange={(event) => autosave.onChange(event.target.value)}
          onFocus={() => setEditing(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              // Close the box, not the panel behind it.
              event.stopPropagation();
              event.currentTarget.blur();
            }
          }}
        />
      )}
    </section>
  );
}
