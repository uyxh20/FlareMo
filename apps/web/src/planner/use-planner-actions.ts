import type {
  PlannerBoardCard,
  PlannerColumn,
  PlannerPlanInput,
  PlannerTaskDetailResponse,
  PlannerTaskPlanResponse,
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
  plannerPredictGoal,
  plannerPredictMove,
  plannerPredictPlan,
  plannerPredictPriority,
  plannerPredictStartDate,
  plannerPredictTitle,
  plannerPredictUndrop,
} from "./board-model";
import { plannerPlanLabel } from "./dates";
import {
  plannerCardFromDetail,
  plannerDetailWithCard,
  plannerDetailWithEffort,
} from "./panel-model";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";
import { type PlannerTaskChangeView, plannerTaskStore } from "./task-store";

// Every change a person can make from the cockpit (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 5 and 13), as optimistic
// edits through the task store (task-store.ts):
//
//   1. Show the card on the cached board, and in the open task panel's cached
//      detail, at once, where the server will put it.
//   2. Send the request.
//   3. Success: keep the fields this edit owns as the server answered them, and
//      say so in a toast when the change needs saying (a card may have moved out
//      of sight). Failure (a 429 included): take this one edit away and say why.
//      Every other edit, saved or still in flight, stays as it is.
//   4. When the last change in flight settles, refresh from the server.
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
  /** The panel's goal: one of the cockpit week's goals, or null for none. */
  setGoal: (card: PlannerBoardCard, goalId: string | null) => void;
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
 * The task store of a query cache (task-store.ts), refreshing the cockpit once the
 * last change that asked for it has settled. The panel's notes and comments use
 * it too, so every change to a task stacks on the same copy.
 */
export function plannerStoreFor(queryClient: QueryClient) {
  return plannerTaskStore(queryClient, () => plannerInvalidateAll(queryClient));
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
  // Numbers the cards that wait for the server, so two quick adds never share an id.
  const serial = useRef(0);

  return useMemo(() => {
    const text = () => stringsRef.current;
    const store = plannerStoreFor(queryClient);

    /** Waits for any fetch of the cockpit's data to stop, so it cannot land over an edit. */
    const cancelFetches = async (taskId: string) => {
      await queryClient.cancelQueries({ queryKey: plannerQueryKeys.boards });
      await queryClient.cancelQueries({
        queryKey: plannerQueryKeys.detail(taskId),
      });
    };

    /** One optimistic edit of one card, and of the task's open panel. */
    const edit = async (
      card: PlannerBoardCard,
      options: {
        predict: (card: PlannerBoardCard) => PlannerBoardCard;
        /**
         * The card fields this edit changes. On success they are taken from the
         * server's answer; every other field stays as the other edits left it.
         */
        fields: readonly (keyof PlannerBoardCard)[];
        /** A change only the panel's detail shows (an effort), after the card's. */
        predictDetail?: (
          detail: PlannerTaskDetailResponse,
        ) => PlannerTaskDetailResponse;
        /** The same change as the server answered it. */
        answerDetail?: (
          detail: PlannerTaskDetailResponse,
          response: PlannerTaskPlanResponse,
        ) => PlannerTaskDetailResponse;
        request: () => Promise<PlannerTaskPlanResponse>;
        /** Left out, the edit is silent when it works. */
        success?: string | (() => string);
        failure: string;
        /** Whether the change can put the card out of sight. Default true. */
        reveal?: boolean;
        /** Place the predicted card here in its column (a drag-and-drop move). */
        position?: PlannerMovePosition;
      },
    ) => {
      // Counted before the first await, so a change that settles meanwhile
      // cannot see nothing in flight and refresh over this one.
      const change = store.begin(card.id);
      try {
        await cancelFetches(card.id);
        change.show(
          cardChangeView(
            card.id,
            options.predict,
            options.position,
            (detail) =>
              options.predictDetail ? options.predictDetail(detail) : detail,
          ),
        );
        if (options.reveal !== false) revealRef.current?.(card.id);
        const response = await options.request();
        const answered = plannerCardFromTask(
          response.task,
          response.plan,
          card.project_name,
        );
        // A card dropped at a place keeps the key the prediction gave it: its
        // neighbours still hold predicted keys, which the server's key for this
        // card does not fit, until the refresh brings every key from the server.
        const owned = options.position
          ? options.fields.filter((field) => field !== "board_rank")
          : options.fields;
        change.saved(
          cardChangeView(
            card.id,
            (current) => ({
              ...options.predict(current),
              ...pickFields(answered, owned),
            }),
            options.position,
            (detail) =>
              options.answerDetail
                ? options.answerDetail(detail, response)
                : detail,
          ),
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
        change.failed();
        toast.error(
          plannerErrorMessage(error, options.failure, text().toast.rateLimited),
          { id: TOAST_ID },
        );
      }
    };

    const actions: PlannerActions = {
      move: (card, to, position) => {
        const placed = position?.beforeId ?? position?.afterId;
        void edit(card, {
          predict: (current) =>
            plannerPredictMove(current, to, { today, now: new Date() }),
          fields: MOVE_FIELDS,
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
          fields: [],
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
          fields: ["horizon", "period_start", "updated_at"],
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
          fields: ["due_at", "updated_at"],
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
          fields: ["dropped_at", "due_at", "updated_at"],
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
          fields: ["dropped_at", "updated_at"],
          request: () =>
            plannerUpdateTaskRequest(card.id, { today, dropped: false }),
          success: () => text().toast.undropped,
          failure: text().toast.undropFailed,
        });
      },

      setTitle: (card, title) => {
        void edit(card, {
          predict: (current) => plannerPredictTitle(current, title, new Date()),
          fields: ["title", "updated_at"],
          request: () => plannerUpdateTaskRequest(card.id, { today, title }),
          failure: text().toast.titleFailed,
          reveal: false,
        });
      },

      setPriority: (card, priority) => {
        void edit(card, {
          predict: (current) =>
            plannerPredictPriority(current, priority, new Date()),
          fields: ["priority", "updated_at"],
          request: () => plannerUpdateTaskRequest(card.id, { today, priority }),
          failure: text().toast.priorityFailed,
          reveal: false,
        });
      },

      setGoal: (card, goalId) => {
        void edit(card, {
          predict: (current) => plannerPredictGoal(current, goalId, new Date()),
          fields: ["goal_id", "updated_at"],
          request: () =>
            plannerUpdateTaskRequest(card.id, { today, goal_id: goalId }),
          failure: text().toast.goalFailed,
          reveal: false,
        });
      },

      setEffort: (card, effort) => {
        void edit(card, {
          // A card carries no effort: only the panel's detail shows it.
          predict: (current) => current,
          fields: [],
          predictDetail: (detail) =>
            plannerDetailWithEffort(detail, effort, new Date()),
          answerDetail: (detail, response) =>
            plannerDetailWithEffort(
              detail,
              response.plan?.effort ?? null,
              response.plan?.updated_at,
            ),
          request: () => plannerUpdateTaskRequest(card.id, { today, effort }),
          failure: text().toast.effortFailed,
          reveal: false,
        });
      },

      setStartDate: (card, startDate) => {
        void edit(card, {
          predict: (current) =>
            plannerPredictStartDate(current, startDate, new Date()),
          fields: ["start_date", "updated_at"],
          request: () =>
            plannerUpdateTaskRequest(card.id, { today, start_date: startDate }),
          failure: text().toast.startFailed,
          reveal: false,
        });
      },

      createIn: async ({ title, column, plan }) => {
        serial.current += 1;
        const pendingId = plannerPendingCardId(serial.current);
        const change = store.begin(pendingId);
        try {
          await queryClient.cancelQueries({
            queryKey: plannerQueryKeys.boards,
          });
          // On the board before the server has heard of it, in the column it was
          // made for and pointed out, so the person sees where it went at once.
          const waiting = plannerPendingCard({
            id: pendingId,
            title,
            column,
            plan,
            now: new Date(),
          });
          change.show({
            board: (board) => {
              // A column with a manual order puts the new card on top of it, as
              // the server does; any other column keeps its natural order.
              const first = board.columns[column][0];
              return first?.board_rank
                ? plannerPlaceCardAt(board, waiting, { beforeId: first.id })
                : plannerPlaceCard(board, waiting);
            },
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
          change.saved({ board: (board) => plannerPlaceCard(board, created) });
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
          change.failed();
          toast.error(
            plannerErrorMessage(
              error,
              text().toast.addFailed,
              text().toast.rateLimited,
            ),
            { id: TOAST_ID },
          );
          return false;
        }
      },
    };
    return actions;
  }, [queryClient, today]);
}

/** The fields a column move changes, taken from the server's answer. */
const MOVE_FIELDS: readonly (keyof PlannerBoardCard)[] = [
  "status",
  "completed_at",
  "horizon",
  "period_start",
  "board_rank",
  "updated_at",
];

/** Just the named fields of a card. */
function pickFields(
  card: PlannerBoardCard,
  fields: readonly (keyof PlannerBoardCard)[],
): Partial<PlannerBoardCard> {
  return Object.fromEntries(fields.map((field) => [field, card[field]]));
}

/**
 * How a change to one card shows: on every cached board, the card rewritten by
 * `predict` and put where its fields say (or at `position`); on its panel's
 * detail, the same card, then `detail` for what only the panel shows.
 */
function cardChangeView(
  taskId: string,
  predict: (card: PlannerBoardCard) => PlannerBoardCard,
  position: PlannerMovePosition | undefined,
  detail: (detail: PlannerTaskDetailResponse) => PlannerTaskDetailResponse,
): PlannerTaskChangeView {
  return {
    board: (board) => {
      const current = plannerFindCard(board, taskId);
      if (!current) return board;
      const next = predict(current);
      return position
        ? plannerPlaceCardAt(board, next, position)
        : plannerPlaceCard(board, next);
    },
    detail: (shown) =>
      detail(
        plannerDetailWithCard(shown, predict(plannerCardFromDetail(shown))),
      ),
  };
}
