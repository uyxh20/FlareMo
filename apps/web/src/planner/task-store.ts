import type {
  PlannerBoardResponse,
  PlannerTaskDetailResponse,
} from "@flaremo/contracts";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { plannerQueryKeys } from "./query-keys";

// One copy of each task on the screen (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 5 and 13). The board, the
// task panel's fields, its notes and its comments all change the same cached task,
// and every one of those changes goes through here.
//
// While any change is waiting for the server, the store keeps two things: the
// last saved copy of every cached board and task detail a change has touched (the
// base), and the queue of changes not yet saved, in the order they were made. What
// the screen shows is always the base with the queue applied on top:
//
//   saved    the change is applied to the base for good, in the form the server
//            answered with, and leaves the queue
//   failed   the change leaves the queue, and nothing else moves
//
// So a failed change can only ever undo itself: never a change that was saved
// meanwhile, and never one still in flight (fork review C01, C02). When the queue
// is empty the store lets go of its copies, and the cached boards and details are
// the server's again; a change that asked for it then refreshes them.

type Board = PlannerBoardResponse;
type Detail = PlannerTaskDetailResponse;

/** How one change shows on a board and on its task's panel detail. */
export type PlannerTaskChangeView = {
  board?: (board: Board) => Board;
  detail?: (detail: Detail) => Detail;
};

export type PlannerTaskStoreChange = {
  /** Shows the change on screen, on top of every change before it. */
  show(view: PlannerTaskChangeView): void;
  /** The server saved it: `view` is the change as answered, applied to the base for good. */
  saved(view: PlannerTaskChangeView): void;
  /** The server refused it, or it never arrived: it disappears, and only it. */
  failed(): void;
};

export type PlannerTaskStore = {
  /**
   * Starts a change to one task. It counts as in flight from this moment, so the
   * refresh after the last change cannot run before it settles. `refresh` asks
   * for the cockpit to be refreshed from the server once nothing is in flight.
   */
  begin(
    taskId: string,
    options?: { refresh?: boolean },
  ): PlannerTaskStoreChange;
  /** How many changes are in flight. */
  readonly inFlight: number;
};

type Entry = { taskId: string; view: PlannerTaskChangeView };

const stores = new WeakMap<QueryClient, PlannerTaskStore>();

/** The store for a query cache: every part of the cockpit shares it. */
export function plannerTaskStore(
  queryClient: QueryClient,
  refresh: () => void,
): PlannerTaskStore {
  let store = stores.get(queryClient);
  if (!store) {
    store = createPlannerTaskStore(queryClient, refresh);
    stores.set(queryClient, store);
  }
  return store;
}

export function createPlannerTaskStore(
  queryClient: QueryClient,
  refresh: () => void,
): PlannerTaskStore {
  /** The last saved copy of each cached board, by its query key's hash. */
  const boards = new Map<string, { key: QueryKey; base: Board }>();
  /** The last saved copy of each touched task's detail, by task id. */
  const details = new Map<string, Detail>();
  /** Changes on screen and not yet settled, oldest first. */
  let queue: Entry[] = [];
  let inFlight = 0;
  let refreshDue = false;

  /** Takes a copy of every cache entry the store does not hold yet. */
  const capture = (taskId: string) => {
    for (const [key, data] of queryClient.getQueriesData<Board>({
      queryKey: plannerQueryKeys.boards,
    })) {
      const hash = JSON.stringify(key);
      if (data && !boards.has(hash)) boards.set(hash, { key, base: data });
    }
    if (!details.has(taskId)) {
      const detail = queryClient.getQueryData<Detail>(
        plannerQueryKeys.detail(taskId),
      );
      if (detail) details.set(taskId, detail);
    }
  };

  /** Writes base plus queue into the cache, for everything the store holds. */
  const render = () => {
    for (const { key, base } of boards.values()) {
      queryClient.setQueryData<Board>(
        key,
        queue.reduce(
          (board, entry) => entry.view.board?.(board) ?? board,
          base,
        ),
      );
    }
    for (const [taskId, base] of details) {
      queryClient.setQueryData<Detail>(
        plannerQueryKeys.detail(taskId),
        queue.reduce(
          (detail, entry) =>
            entry.taskId === taskId
              ? (entry.view.detail?.(detail) ?? detail)
              : detail,
          base,
        ),
      );
    }
  };

  const settle = () => {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight > 0) return;
    // Nothing is waiting: the cache is the server's again.
    boards.clear();
    details.clear();
    queue = [];
    if (refreshDue) {
      refreshDue = false;
      refresh();
    }
  };

  return {
    get inFlight() {
      return inFlight;
    },
    begin(taskId, options = {}) {
      inFlight += 1;
      if (options.refresh !== false) refreshDue = true;
      let entry: Entry | undefined;
      let done = false;
      return {
        show(view) {
          if (done || entry) return;
          capture(taskId);
          entry = { taskId, view };
          queue.push(entry);
          render();
        },
        saved(view) {
          if (done) return;
          done = true;
          capture(taskId);
          for (const [hash, held] of boards) {
            boards.set(hash, {
              key: held.key,
              base: view.board?.(held.base) ?? held.base,
            });
          }
          const detail = details.get(taskId);
          if (detail && view.detail) details.set(taskId, view.detail(detail));
          queue = queue.filter((other) => other !== entry);
          render();
          settle();
        },
        failed() {
          if (done) return;
          done = true;
          queue = queue.filter((other) => other !== entry);
          render();
          settle();
        },
      };
    },
  };
}
