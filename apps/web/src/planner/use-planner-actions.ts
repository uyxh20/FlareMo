import type {
  PlannerBoardCard,
  PlannerBoardResponse,
  PlannerColumn,
  PlannerPlanInput,
  PlannerTaskDetailResponse,
  PlannerTaskPlanResponse,
  PlannerTaskProject,
  TaskPriority,
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
  plannerCardColumn,
  plannerCardFromTask,
  plannerFindCard,
  plannerPendingCard,
  plannerPendingCardId,
  plannerPlaceCard,
  plannerPlaceCardAt,
  plannerPredictDrop,
  plannerPredictDue,
  plannerPredictMove,
  plannerPredictPlan,
  plannerPredictPriority,
  plannerPredictProject,
  plannerPredictStartDate,
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

/**
 * Where in a column a moved card goes: directly above `beforeId`, or directly
 * below `afterId` (ids of cards in the target column). Left out, the card lands
 * where the column's natural order puts it.
 */
export type PlannerMovePosition = { beforeId?: string; afterId?: string };

export type PlannerActions = {
  move: (
    card: PlannerBoardCard,
    to: PlannerColumn,
    position?: PlannerMovePosition,
  ) => void;
  /** A reorder inside the column the card is already in. */
  reorder: (card: PlannerBoardCard, position: PlannerMovePosition) => void;
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
  /** The panel's start date, a day or null. */
  setStartDate: (card: PlannerBoardCard, startDate: string | null) => void;
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
        predict: (card: PlannerBoardCard) => PlannerBoardCard;
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
        /** Place the predicted card here in its column (a drag-and-drop move). */
        position?: PlannerMovePosition;
      },
    ) => {
      // Counted before the first await, so a change that settles meanwhile
      // cannot see zero in flight and refresh over this one.
      pending.current += 1;
      const detailKey = plannerQueryKeys.detail(card.id);
      const detailBefore =
        queryClient.getQueryData<PlannerTaskDetailResponse>(detailKey);
      let boardsBefore: [
        readonly unknown[],
        PlannerBoardResponse | undefined,
      ][] = [];
      try {
        await queryClient.cancelQueries({ queryKey: plannerQueryKeys.boards });
        await queryClient.cancelQueries({ queryKey: detailKey });
        // A positioned move can re-rank its neighbours too, so a rollback
        // restores whole columns from here instead of only putting the card back.
        boardsBefore = queryClient.getQueriesData<PlannerBoardResponse>({
          queryKey: plannerQueryKeys.boards,
        });
        const position = options.position;
        patchBoards((board) => {
          const current = plannerFindCard(board, card.id);
          if (!current) return board;
          const predicted = options.predict(current);
          return position
            ? plannerPlaceCardAt(board, predicted, position)
            : plannerPlaceCard(board, predicted);
        });
        patchDetail(card.id, (detail) => {
          const predicted = options.predict(plannerCardFromDetail(detail));
          const shown = plannerDetailWithCard(detail, predicted);
          return options.predictDetail ? options.predictDetail(shown) : shown;
        });
        if (options.reveal !== false) revealRef.current?.(card.id);
        const response = await options.request();
        patchBoards((board) =>
          plannerUpdateCard(board, card.id, (current) => {
            const answered = plannerCardFromTask(
              response.task,
              response.plan,
              options.projectName === undefined
                ? card.project_name
                : options.projectName,
            );
            // The neighbours still hold the keys the prediction gave them, which
            // the server's key for this card does not fit; keep the predicted one
            // until the refresh brings every key from the server.
            return options.position
              ? { ...answered, board_rank: current.board_rank }
              : answered;
          }),
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
        if (options.position) {
          // Put the columns the move touched back exactly as they were.
          const columns = new Set<string>([
            plannerCardColumn(card),
            plannerCardColumn(options.predict(card)),
          ]);
          for (const [key, before] of boardsBefore) {
            if (!before) continue;
            queryClient.setQueryData<PlannerBoardResponse>(key, (board) =>
              board
                ? {
                    ...board,
                    columns: {
                      ...board.columns,
                      ...Object.fromEntries(
                        [...columns]
                          .filter((name) => name in before.columns)
                          .map((name) => [
                            name,
                            before.columns[name as keyof typeof before.columns],
                          ]),
                      ),
                    },
                  }
                : board,
            );
          }
        } else {
          patchBoards((board) => plannerPlaceCard(board, card));
        }
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
      move: (card, to, position) => {
        const placed = position?.beforeId ?? position?.afterId;
        void edit(card, {
          predict: (current) =>
            plannerPredictMove(current, to, { today, now: new Date() }),
          request: () =>
            plannerUpdateTaskRequest(card.id, {
              today,
              column: to,
              ...(position?.beforeId ? { before_id: position.beforeId } : {}),
              ...(!position?.beforeId && position?.afterId
                ? { after_id: position.afterId }
                : {}),
            }),
          // A card dropped at a place is on the board where it was put, so the
          // toast only names the column when it went to another one.
          success: () => text().toast.moved(text().column[to]),
          failure: text().toast.moveFailed,
          // Dropped at a place, the card is right under the pointer already.
          reveal: placed ? false : undefined,
          position: placed ? position : undefined,
        });
      },

      reorder: (card, position) => {
        const column = plannerCardColumn(card);
        if (column === "dropped" || column === "other") return;
        void edit(card, {
          // Same column, so only the card's place changes.
          predict: (current) => current,
          request: () =>
            plannerUpdateTaskRequest(card.id, {
              today,
              column,
              ...(position.beforeId
                ? { before_id: position.beforeId }
                : position.afterId
                  ? { after_id: position.afterId }
                  : {}),
            }),
          failure: text().toast.reorderFailed,
          reveal: false,
          position,
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

      setStartDate: (card, startDate) => {
        void edit(card, {
          predict: (current) =>
            plannerPredictStartDate(current, startDate, new Date()),
          request: () =>
            plannerUpdateTaskRequest(card.id, { today, start_date: startDate }),
          failure: text().toast.startFailed,
          reveal: false,
        });
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
          patchBoards((board) => {
            const waiting = plannerPendingCard({
              id: pendingId,
              title,
              column,
              plan,
              now: new Date(),
            });
            // A column with a manual order puts the new card on top of it, as the
            // server does; any other column keeps its natural order.
            const first = board.columns[column][0];
            return first?.board_rank
              ? plannerPlaceCardAt(board, waiting, { beforeId: first.id })
              : plannerPlaceCard(board, waiting);
          });
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
