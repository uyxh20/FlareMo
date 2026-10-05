import type {
  PlannerBoardCard,
  PlannerBoardResponse,
  PlannerColumn,
  PlannerPlanInput,
  PlannerTaskPlanResponse,
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
  plannerPlaceCard,
  plannerPredictDrop,
  plannerPredictDue,
  plannerPredictMove,
  plannerPredictPlan,
  plannerPredictUndrop,
  plannerUpdateCard,
} from "./board-model";
import { plannerPlanLabel } from "./dates";
import {
  type PlannerQuickAddChoice,
  plannerQuickAddPlan,
} from "./plan-targets";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerStrings } from "./strings";

// Every change a person can make from the cockpit (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5), as optimistic edits:
//
//   1. Patch the card into the cached board at once, where the server will put it.
//   2. Send the request.
//   3. Success: put the server's card in its place, say so in a toast.
//      Failure (a 429 included): put this one card back as it was and say why.
//   4. When the last change in flight settles, refresh from the server.
//
// A rollback restores the one card, not the whole board, so it cannot undo a
// second edit that was made while the first was still in flight, and the refresh
// waits for every change to settle so it cannot snap a still-pending card back.

export type PlannerActions = {
  move: (card: PlannerBoardCard, to: PlannerColumn) => void;
  plan: (card: PlannerBoardCard, plan: PlannerPlanInput | null) => void;
  setDue: (card: PlannerBoardCard, due: string | null) => void;
  drop: (card: PlannerBoardCard) => void;
  undrop: (card: PlannerBoardCard) => void;
  /** Resolves true when the task was created, so the caller can clear its input. */
  create: (input: {
    title: string;
    choice: PlannerQuickAddChoice;
  }) => Promise<boolean>;
};

/** Refreshes the cockpit, upstream's task lists and the project counts. */
export function plannerInvalidateAll(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: plannerQueryKeys.all });
  void queryClient.invalidateQueries({ queryKey: queryKeys.tasks.all });
  void queryClient.invalidateQueries({ queryKey: ["projects"] });
}

const TOAST_ID = "planner-edit";

export function usePlannerActions(input: { today: string }): PlannerActions {
  const { today } = input;
  const queryClient = useQueryClient();
  const strings = usePlannerStrings();
  const stringsRef = useRef(strings);
  stringsRef.current = strings;
  const pending = useRef(0);

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

    const settle = () => {
      pending.current = Math.max(0, pending.current - 1);
      if (pending.current === 0) plannerInvalidateAll(queryClient);
    };

    /** One optimistic edit of one card. */
    const edit = async (
      card: PlannerBoardCard,
      options: {
        predict: (
          card: PlannerBoardCard,
          board: PlannerBoardResponse,
        ) => PlannerBoardCard;
        request: () => Promise<PlannerTaskPlanResponse>;
        success: string | (() => string);
        failure: string;
      },
    ) => {
      // Counted before the first await, so a change that settles meanwhile
      // cannot see zero in flight and refresh over this one.
      pending.current += 1;
      try {
        await queryClient.cancelQueries({ queryKey: plannerQueryKeys.boards });
        patchBoards((board) =>
          plannerUpdateCard(board, card.id, (current) =>
            options.predict(current, board),
          ),
        );
        const response = await options.request();
        patchBoards((board) =>
          plannerUpdateCard(board, card.id, () =>
            plannerCardFromTask(
              response.task,
              response.plan,
              card.project_name,
            ),
          ),
        );
        toast.success(
          typeof options.success === "function"
            ? options.success()
            : options.success,
          { id: TOAST_ID },
        );
      } catch (error) {
        patchBoards((board) => plannerPlaceCard(board, card));
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
          predict: (current, board) =>
            plannerPredictMove(current, to, {
              today,
              week: board.periods.week,
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
        });
      },

      drop: (card) => {
        void edit(card, {
          predict: (current) => plannerPredictDrop(current, new Date()),
          request: () =>
            plannerUpdateTaskRequest(card.id, { today, dropped: true }),
          success: () => text().toast.dropped,
          failure: text().toast.dropFailed,
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
    };
    return actions;
  }, [queryClient, today]);
}
