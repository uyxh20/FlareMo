import {
  type PlannerBoardCard,
  type PlannerBoardResponse,
  type PlannerColumn,
  type PlannerPlanInput,
  type PlannerTaskDetailResponse,
  type PlannerTaskPlanResponse,
  type PlannerTaskProject,
  plannerPeriodStart,
  type TaskPriority,
} from "@flaremo/contracts";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef } from "react";
import { toast } from "sonner";
import { queryKeys } from "@/lib/query-keys";
import {
  plannerCreateTaskRequest,
  plannerErrorMessage,
  plannerUpdateTaskRequest,
} from "./api";
import {
  plannerCardFromTask,
  plannerPendingCard,
  plannerPendingCardId,
  plannerPlaceCard,
  plannerPredictDrop,
  plannerPredictDue,
  plannerPredictMove,
  plannerPredictPlan,
  plannerPredictPriority,
  plannerPredictProject,
  plannerPredictTitle,
  plannerPredictUndrop,
  plannerRemoveCard,
  plannerUpdateCard,
} from "./board-model";
import { plannerPlanLabel } from "./dates";
import {
  plannerCardFromDetail,
  plannerDetailWithAnswer,
  plannerDetailWithCard,
  plannerDetailWithEffort,
} from "./panel-model";
import {
  type PlannerQuickAddChoice,
  plannerQuickAddPlan,
} from "./plan-targets";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";

// Every change a person can make from the cockpit (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 5 and 13), as optimistic
// edits:
//
//   1. Patch the card into the cached board, and into the open task panel's
//      cached detail, at once, where the server will put it.
//   2. Send the request.
//   3. Success: put the server's answer in their place, and say so in a toast
//      when the change needs saying (a card may have moved out of sight).
//      Failure (a 429 included): put this one card, and its detail, back as they
//      were and say why.
//   4. When the last change in flight settles, refresh from the server.
//
// A rollback restores the one card, not the whole board, so it cannot undo a
// second edit that was made while the first was still in flight, and the refresh
// waits for every change to settle so it cannot snap a still-pending card back.
//
// A change that moves a card (a quick add, a move, a re-plan, an undrop) also asks
// the page to point the card out, scrolled into view with a ring, because the
// card may now sit below the fold or in a column that is off screen. A due date
// leaves the card where it is, and a drop sends it away, so neither asks.
//
// The task panel's edits (title, priority, goal, effort) go through the same
// engine. They are silent when they work, because the panel shows the new value
// where it was edited, and loud when they do not: the value goes back and a toast
// says why.

export type PlannerActions = {
  move: (card: PlannerBoardCard, to: PlannerColumn) => void;
  plan: (card: PlannerBoardCard, plan: PlannerPlanInput | null) => void;
  setDue: (card: PlannerBoardCard, due: string | null) => void;
  drop: (card: PlannerBoardCard) => void;
  undrop: (card: PlannerBoardCard) => void;
  /** The panel's title: trimmed by the server like any upstream title. */
  setTitle: (card: PlannerBoardCard, title: string) => void;
  setPriority: (card: PlannerBoardCard, priority: TaskPriority) => void;
  /** The panel's goal: a project with its path above it, or null for none. */
  setProject: (
    card: PlannerBoardCard,
    project: PlannerTaskProject | null,
  ) => void;
  /** The panel's effort estimate, 0 to 999 with at most one decimal, or null. */
  setEffort: (card: PlannerBoardCard, effort: number | null) => void;
  /** Resolves true when the task was created, so the caller can clear its input. */
  create: (input: {
    title: string;
    choice: PlannerQuickAddChoice;
  }) => Promise<boolean>;
  /**
   * Adds a task straight into a column, the way a column's "+" does. The card is
   * on the board at once, under a pending id, and is swapped for the real one when
   * the server answers or taken away when it refuses. Resolves true when the task
   * was created, so the composer can keep its text when it was not.
   */
  createIn: (input: {
    title: string;
    column: PlannerColumn;
    plan: PlannerPlanInput | null;
  }) => Promise<boolean>;
};

/** Refreshes the cockpit, upstream's task lists and the project counts. */
export function plannerInvalidateAll(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: plannerQueryKeys.all });
  void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
  void queryClient.invalidateQueries({ queryKey: ["projects"] });
}

/**
 * The one toast every cockpit edit uses, so a run of edits replaces the toast
 * instead of piling up. The panel's own saves (notes, comments) share it.
 */
export const plannerToastId = "planner-edit";
const TOAST_ID = plannerToastId;

export function usePlannerActions(input: {
  today: string;
  /** Points a card out after a change that moved it (see use-planner-reveal.ts). */
  reveal?: (taskId: string) => void;
}): PlannerActions {
  const { today } = input;
  const queryClient = useQueryClient();
  const strings = usePlannerStrings();
  const stringsRef = useRef(strings);
  stringsRef.current = strings;
  const revealRef = useRef(input.reveal);
  revealRef.current = input.reveal;
  const pending = useRef(0);
  // Numbers the cards that wait for the server, so two quick adds never share an id.
  const serial = useRef(0);

  return useMemo(() => {
    const text = () => stringsRef.current;

    /** Applies `change` to every cached board. */
    const patchBoards = (
      change: (board: PlannerBoardResponse) => PlannerBoardResponse,
    ) => {
      queryClient.setQueriesData<PlannerBoardResponse>(
        { queryKey: plannerQueryKeys.boards },
        (board) => (board ? change(board) : board),
      );
    };

    /** Applies `change` to one task's cached panel detail, when it has one. */
    const patchDetail = (
      taskId: string,
      change: (detail: PlannerTaskDetailResponse) => PlannerTaskDetailResponse,
    ) => {
      queryClient.setQueryData<PlannerTaskDetailResponse>(
        plannerQueryKeys.detail(taskId),
        (detail) => (detail ? change(detail) : detail),
      );
    };

    const settle = () => {
      pending.current = Math.max(0, pending.current - 1);
      if (pending.current === 0) plannerInvalidateAll(queryClient);
    };

    /** One optimistic edit of one card, and of the task's open panel. */
    const edit = async (
      card: PlannerBoardCard,
      options: {
        predict: (
          card: PlannerBoardCard,
          context: { week: string },
        ) => PlannerBoardCard;
        /** A change only the panel's detail shows (an effort), after the card's. */
        predictDetail?: (
          detail: PlannerTaskDetailResponse,
        ) => PlannerTaskDetailResponse;
        request: () => Promise<PlannerTaskPlanResponse>;
        /** Left out, the edit is silent when it works. */
        success?: string | (() => string);
        failure: string;
        /** Whether the change can put the card out of sight. Default true. */
        reveal?: boolean;
        /** The project name the card shows after the edit; default: the one it had. */
        projectName?: string | null;
      },
    ) => {
      // Counted before the first await, so a change that settles meanwhile
      // cannot see zero in flight and refresh over this one.
      pending.current += 1;
      const detailKey = plannerQueryKeys.detail(card.id);
      const detailBefore =
        queryClient.getQueryData<PlannerTaskDetailResponse>(detailKey);
      try {
        await queryClient.cancelQueries({ queryKey: plannerQueryKeys.boards });
        await queryClient.cancelQueries({ queryKey: detailKey });
        patchBoards((board) =>
          plannerUpdateCard(board, card.id, (current) =>
            options.predict(current, { week: board.periods.week }),
          ),
        );
        patchDetail(card.id, (detail) => {
          const predicted = options.predict(plannerCardFromDetail(detail), {
            week: plannerPeriodStart("week", today),
          });
          const shown = plannerDetailWithCard(detail, predicted);
          return options.predictDetail ? options.predictDetail(shown) : shown;
        });
        if (options.reveal !== false) revealRef.current?.(card.id);
        const response = await options.request();
        patchBoards((board) =>
          plannerUpdateCard(board, card.id, () =>
            plannerCardFromTask(
              response.task,
              response.plan,
              options.projectName === undefined
                ? card.project_name
                : options.projectName,
            ),
          ),
        );
        patchDetail(card.id, (detail) =>
          plannerDetailWithAnswer(detail, response),
        );
        if (options.success !== undefined) {
          toast.success(
            typeof options.success === "function"
              ? options.success()
              : options.success,
            { id: TOAST_ID },
          );
        }
      } catch (error) {
        patchBoards((board) => plannerPlaceCard(board, card));
        if (detailBefore) queryClient.setQueryData(detailKey, detailBefore);
        toast.error(
          plannerErrorMessage(error, options.failure, text().toast.rateLimited),
          { id: TOAST_ID },
        );
      } finally {
        settle();
      }
    };

    const actions: PlannerActions = {
      move: (card, to) => {
        void edit(card, {
          predict: (current, context) =>
            plannerPredictMove(current, to, {
              today,
              week: context.week,
              now: new Date(),
            }),
          request: () =>
            plannerUpdateTaskRequest(card.id, { today, column: to }),
          success: () => text().toast.moved(text().column[to]),
          failure: text().toast.moveFailed,
        });
      },

      plan: (card, plan) => {
        void edit(card, {
          predict: (current) => plannerPredictPlan(current, plan, new Date()),
          request: () => plannerUpdateTaskRequest(card.id, { today, plan }),
          success: () => {
            const label = plan
              ? plannerPlanLabel(
                  {
                    horizon: plan.horizon,
                    period_start: plan.day,
                  },
                  today,
                  text(),
                  "phrase",
                )?.label
              : null;
            return label
              ? text().toast.planned(label)
              : text().toast.planCleared;
          },
          failure: text().toast.planFailed,
        });
      },

      setDue: (card, due) => {
        void edit(card, {
          predict: (current) => plannerPredictDue(current, due, new Date()),
          request: () =>
            plannerUpdateTaskRequest(card.id, { today, due_at: due }),
          success: () =>
            due ? text().toast.dueSet(due) : text().toast.dueCleared,
          failure: text().toast.dueFailed,
          reveal: false,
        });
      },

      drop: (card) => {
        void edit(card, {
          predict: (current) => plannerPredictDrop(current, new Date()),
          request: () =>
            plannerUpdateTaskRequest(card.id, { today, dropped: true }),
          success: () => text().toast.dropped,
          failure: text().toast.dropFailed,
          reveal: false,
        });
      },

      undrop: (card) => {
        void edit(card, {
          predict: (current) => plannerPredictUndrop(current, new Date()),
          request: () =>
            plannerUpdateTaskRequest(card.id, { today, dropped: false }),
          success: () => text().toast.undropped,
          failure: text().toast.undropFailed,
        });
      },

      setTitle: (card, title) => {
        void edit(card, {
          predict: (current) => plannerPredictTitle(current, title, new Date()),
          request: () => plannerUpdateTaskRequest(card.id, { today, title }),
          failure: text().toast.titleFailed,
          reveal: false,
        });
      },

      setPriority: (card, priority) => {
        void edit(card, {
          predict: (current) =>
            plannerPredictPriority(current, priority, new Date()),
          request: () => plannerUpdateTaskRequest(card.id, { today, priority }),
          failure: text().toast.priorityFailed,
          reveal: false,
        });
      },

      setProject: (card, project) => {
        void edit(card, {
          predict: (current) =>
            plannerPredictProject(current, project, new Date()),
          predictDetail: (detail) => ({ ...detail, project }),
          request: () =>
            plannerUpdateTaskRequest(card.id, {
              today,
              project_id: project?.id ?? null,
            }),
          projectName: project?.name ?? null,
          failure: text().toast.goalFailed,
          reveal: false,
        });
      },

      setEffort: (card, effort) => {
        void edit(card, {
          // A card carries no effort: only the panel's detail shows it.
          predict: (current) => current,
          predictDetail: (detail) =>
            plannerDetailWithEffort(detail, effort, new Date()),
          request: () => plannerUpdateTaskRequest(card.id, { today, effort }),
          failure: text().toast.effortFailed,
          reveal: false,
        });
      },

      create: async ({ title, choice }) => {
        const plan = plannerQuickAddPlan(choice, today);
        pending.current += 1;
        try {
          const response = await plannerCreateTaskRequest({
            title,
            today,
            ...(plan ? { plan } : {}),
          });
          const created = plannerCardFromTask(response.task, response.plan);
          patchBoards((board) => plannerPlaceCard(board, created));
          revealRef.current?.(created.id);
          if (response.plan_error) {
            // The task exists and sits in the backlog; offer to try the plan again.
            toast.warning(text().toast.planNotSaved, {
              id: TOAST_ID,
              action: plan
                ? {
                    label: text().toast.retryPlan,
                    onClick: () => actions.plan(created, plan),
                  }
                : undefined,
            });
          } else {
            toast.success(
              text().toast.added[choice === "backlog" ? "backlog" : choice],
              { id: TOAST_ID },
            );
          }
          return true;
        } catch (error) {
          toast.error(
            plannerErrorMessage(
              error,
              text().toast.addFailed,
              text().toast.rateLimited,
            ),
            { id: TOAST_ID },
          );
          return false;
        } finally {
          settle();
        }
      },

      createIn: async ({ title, column, plan }) => {
        serial.current += 1;
        const pendingId = plannerPendingCardId(serial.current);
        pending.current += 1;
        try {
          await queryClient.cancelQueries({
            queryKey: plannerQueryKeys.boards,
          });
          // On the board before the server has heard of it, in the column it was
          // made for and pointed out, so the person sees where it went at once.
          patchBoards((board) =>
            plannerPlaceCard(
              board,
              plannerPendingCard({
                id: pendingId,
                title,
                column,
                plan,
                now: new Date(),
              }),
            ),
          );
          revealRef.current?.(pendingId);

          const response = await plannerCreateTaskRequest({
            title,
            today,
            column,
            ...(plan ? { plan } : {}),
          });
          const created = plannerCardFromTask(response.task, response.plan);
          // The pending card gives way to the real one, which takes its place.
          patchBoards((board) =>
            plannerPlaceCard(plannerRemoveCard(board, pendingId), created),
          );
          revealRef.current?.(created.id);
          if (response.plan_error) {
            // The task exists, in its column, without the plan it was given.
            toast.warning(text().toast.planNotSaved, {
              id: TOAST_ID,
              action: plan
                ? {
                    label: text().toast.retryPlan,
                    onClick: () => actions.plan(created, plan),
                  }
                : undefined,
            });
          } else {
            toast.success(text().toast.addedTo(text().column[column]), {
              id: TOAST_ID,
            });
          }
          return true;
        } catch (error) {
          patchBoards((board) => plannerRemoveCard(board, pendingId));
          toast.error(
            plannerErrorMessage(
              error,
              text().toast.addFailed,
              text().toast.rateLimited,
            ),
            { id: TOAST_ID },
          );
          return false;
        } finally {
          settle();
        }
      },
    };
    return actions;
  }, [queryClient, today]);
}
