import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useI18n } from "@/i18n";
import { stripResourceName } from "@/lib/utils";
import { TaskFormDialog } from "@/pages/projects/task-form-dialog";
import { plannerFetchTask } from "./api";
import { PlannerDayDialog } from "./day-dialog";
import { PlannerHistorySheet } from "./history-sheet";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";
import type { PlannerCardRequest } from "./task-card";
import {
  type PlannerActions,
  plannerInvalidateAll,
} from "./use-planner-actions";

// The dialogs and the history sheet a card can ask for (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5). There is one of each
// for the whole board instead of one per card: a board can hold hundreds of
// cards, and only one dialog is ever open.

type Shown = { request: PlannerCardRequest; stamp: number };

/**
 * Which request is showing. The last request is kept after it closes, so a
 * dialog still has its content while it fades out; `stamp` is new for every
 * request, so a dialog that must start from fresh data can remount.
 */
export function usePlannerCardRequests() {
  const [shown, setShown] = useState<Shown | null>(null);
  const [open, setOpen] = useState(false);
  const show = useCallback((request: PlannerCardRequest) => {
    setShown((previous) => ({
      request,
      stamp: (previous?.stamp ?? 0) + 1,
    }));
    setOpen(true);
  }, []);
  const close = useCallback(() => setOpen(false), []);
  return { shown, open, show, close };
}

/**
 * Upstream's edit dialog, as it is. A board card has no notes, and the dialog
 * saves every field it shows, so it is opened with the whole task from the
 * server rather than the card: saving must not blank the notes.
 *
 * The task is fetched once per request and never refetched while the dialog
 * lives (`staleTime: Infinity`, dropped from the cache when it unmounts), because
 * the dialog re-seeds its fields whenever the task it is given changes.
 */
function PlannerEditDialog({
  taskId,
  open,
  onOpenChange,
}: {
  taskId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const strings = usePlannerStrings();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: plannerQueryKeys.task(taskId),
    queryFn: () => plannerFetchTask(taskId),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (query.isError && open) {
      toast.error(strings.toast.openFailed);
      onOpenChange(false);
    }
  }, [query.isError, open, onOpenChange, strings]);

  // The dialog's project list holds bare ids ("<uuid>") while a task stores a
  // namespaced one ("projects/<uuid>"), so handed the task as it is, the select
  // matches nothing, shows "Unassigned" and saves the task out of its project.
  // Giving it the bare id is the same task, spelled the way the options are.
  const fetched = query.data?.task;
  const task = useMemo(
    () =>
      fetched && {
        ...fetched,
        project_id: fetched.project_id
          ? stripResourceName(fetched.project_id, "projects")
          : null,
      },
    [fetched],
  );
  if (!task) return null;
  return (
    <TaskFormDialog
      key={task.id}
      open={open}
      task={task}
      onOpenChange={onOpenChange}
      onSaved={() => plannerInvalidateAll(queryClient)}
    />
  );
}

export function PlannerCardDialogs({
  shown,
  open,
  onClose,
  actions,
}: {
  shown: Shown | null;
  open: boolean;
  onClose: () => void;
  actions: PlannerActions;
}) {
  const { t } = useI18n();
  const strings = usePlannerStrings();
  const request = shown?.request ?? null;
  const kind = request?.kind;
  const onOpenChange = (next: boolean) => {
    if (!next) onClose();
  };

  return (
    <>
      <AlertDialog open={open && kind === "drop"} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{strings.dropDialog.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {strings.dropDialog.body}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (request) actions.drop(request.card);
              }}
            >
              {strings.dropDialog.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <PlannerDayDialog
        confirmLabel={strings.dayDialog.dueConfirm}
        description={strings.dayDialog.dueDescription}
        initial={request?.card.due_at ?? null}
        open={open && kind === "setDue"}
        title={strings.dayDialog.dueTitle}
        onConfirm={(day) => {
          if (request) actions.setDue(request.card, day);
        }}
        onOpenChange={onOpenChange}
      />

      {shown && kind === "edit" && (
        <PlannerEditDialog
          key={shown.stamp}
          open={open}
          taskId={shown.request.card.id}
          onOpenChange={onOpenChange}
        />
      )}

      <PlannerHistorySheet
        card={kind === "history" ? (request?.card ?? null) : null}
        open={open && kind === "history"}
        onOpenChange={onOpenChange}
      />
    </>
  );
}
