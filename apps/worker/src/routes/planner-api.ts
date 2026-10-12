import {
  type PlannerBoardResponse,
  type PlannerCommentListResponse,
  type PlannerCommentResponse,
  type PlannerCreateTaskResponse,
  type PlannerDeleteCommentResponse,
  type PlannerHistoryRangeResponse,
  type PlannerRolloverResponse,
  type PlannerRollupResponse,
  type PlannerTaskDetailResponse,
  type PlannerTaskHistoryResponse,
  type PlannerTaskPlanResponse,
  type PlannerTreeNodeResponse,
  type PlannerTreeResponse,
  plannerBoardQuerySchema,
  plannerCreateCommentSchema,
  plannerCreateTaskSchema,
  plannerHistoryRangeQuerySchema,
  plannerRolloverSchema,
  plannerRollupQuerySchema,
  plannerUpdateCommentSchema,
  plannerUpdateTaskSchema,
  plannerUpdateTreeNodeSchema,
} from "@flaremo/contracts";
import { parseResourceName, updateTask } from "@flaremo/domain";
import {
  plannerAddComment,
  plannerApplyColumnMove,
  plannerCreateTask,
  plannerDeleteComment,
  plannerDropTask,
  plannerListComments,
  plannerRankNewTaskOnTop,
  plannerReadBoard,
  plannerReadCockpitWeek,
  plannerReadHistoryRange,
  plannerReadRollup,
  plannerReadTaskDetail,
  plannerReadTaskHistory,
  plannerReadTaskPlan,
  plannerReadTree,
  plannerRollover,
  plannerSetBoardRank,
  plannerSetEffort,
  plannerSetPlan,
  plannerSetStartDate,
  plannerSyncHistory,
  plannerUndropTask,
  plannerUpdateComment,
  plannerUpsertProjectNode,
} from "@flaremo/domain/src/planner";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getRequestContext, type HonoBindings } from "../context";
import { jsonError } from "../http";
import { rateLimitGuard } from "../rate-limit";
import { plannerGoalsApi } from "./planner-goals-api";
import {
  plannerAssertToday,
  plannerResolveActor,
} from "./planner-route-helpers";

// The planning cockpit's HTTP API (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 4), mounted lazily at
// /api/app/planner and registered before /api/app so nothing there can shadow it.
//
// It authenticates exactly like tasks-api.ts: `getRequestContext` accepts a
// cookie session (state-changing requests must carry FlareMo's Origin) or a
// `memos_pat_` PAT, and the actor comes from the credential. All logic lives in
// packages/domain/src/planner (M2); the routes only validate, authenticate,
// throttle and serialise. Each response is typed with its contract, so a domain
// type that drifts from the wire shape fails to compile here.

export const plannerApi = new Hono<HonoBindings>();

// A uniform JSON envelope for unknown paths, like every other /api/* 404. The
// lazy mount hands requests to this sub-app, so its own 404 would otherwise be
// Hono's plain text.
plannerApi.notFound((c) => c.json({ error: { message: "Not found" } }, 404));

// `/api/app/*` routes take a bare resource id in the URL path; the shared
// helper prepends the namespaced prefix (and passes namespaced names through).
function parseTaskId(value: string) {
  return parseResourceName(value, "tasks");
}

// --- Board and rollover -----------------------------------------------------

// The board also carries the week the cockpit's goal cards show and that week's
// goals (migration 9005), so the cockpit draws both from one request.
//
// The board syncs the history archive first, as rollover did before the web stopped
// calling it (section 13.x): loading the cockpit is what keeps the archive current.
// The sync is debounced to 30 seconds and never throws, so a failed sync leaves the
// board readable (its `history` field says `paused`).
plannerApi.get(
  "/board",
  zValidator("query", plannerBoardQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const query = c.req.valid("query");
      plannerAssertToday(query.today, new Date());
      await plannerSyncHistory(db, { userId: user.id, now: new Date() });
      const [board, week] = await Promise.all([
        plannerReadBoard(db, {
          userId: user.id,
          today: query.today,
          doneDays: query.done_days,
          includeDropped: query.include_dropped,
        }),
        plannerReadCockpitWeek(db, { userId: user.id, today: query.today }),
      ]);
      const response: PlannerBoardResponse = { ...board, week };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerApi.post(
  "/rollover",
  zValidator("json", plannerRolloverSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const { today } = c.req.valid("json");
      const now = new Date();
      plannerAssertToday(today, now);
      const result: PlannerRolloverResponse = await plannerRollover(
        context.db,
        {
          userId: context.user.id,
          actor: plannerResolveActor(c, context.credential),
          today,
          now,
        },
      );
      return c.json(result);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// --- Tasks ------------------------------------------------------------------

plannerApi.post(
  "/tasks",
  zValidator("json", plannerCreateTaskSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      plannerAssertToday(body.today, new Date());
      const created = await plannerCreateTask(context.db, {
        user: context.user,
        actor: plannerResolveActor(c, context.credential),
        title: body.title,
        notes: body.notes,
        priority: body.priority,
        dueAt: body.due_at,
        projectId: body.project_id,
        column: body.column,
        plan: body.plan,
        today: body.today,
      });
      const { task, planError } = created;
      let plan = created.plan;
      // A column with a manual order puts the new card on top of it (migration
      // 9004); an unranked column keeps its natural order and nothing is written.
      if (
        body.column !== undefined &&
        (await plannerRankNewTaskOnTop(context.db, {
          userId: context.user.id,
          taskId: task.id,
          column: body.column,
        }))
      ) {
        plan = (
          await plannerReadTaskPlan(context.db, {
            user: context.user,
            taskId: task.id,
          })
        ).plan;
      }
      // The task exists either way. When only its plan could not be saved,
      // `plan` is null and `plan_error` tells the client to offer a retry.
      const response: PlannerCreateTaskResponse = {
        task,
        plan,
        ...(planError ? { plan_error: planError } : {}),
      };
      return c.json(response, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// Everything the task panel shows: the whole task (notes included, which a board
// card leaves out), its plan with the effort estimate, its goal with the path of
// goals above it, and its comments. A task that is missing, in the recycle bin or
// someone else's is a 404. Reads are not throttled and write nothing.
plannerApi.get("/tasks/:id", async (c) => {
  try {
    const { db, user } = await getRequestContext(c);
    const detail: PlannerTaskDetailResponse = await plannerReadTaskDetail(db, {
      userId: user.id,
      taskId: parseTaskId(c.req.param("id")),
    });
    return c.json(detail);
  } catch (error) {
    return jsonError(c, error);
  }
});

// One request can change a task's status column, plan, effort, start date, drop state
// and upstream fields together. The order is the contract (documented on
// `plannerUpdateTaskSchema`): undrop first, so a dropped task can be planned or
// moved in the same request; then the upstream fields, through upstream's own
// `updateTask` and only the fields given; then the column move (and, with `before_id` or
// `after_id`, its place in the column) or the plan (the schema rejects column
// and plan together); then the effort estimate and the start date; and
// drop last, so it also clears a due date set a step earlier. The steps are separate
// writes, so a step that fails leaves the earlier ones applied. No step is given a
// shared `now`: each reads the clock when it runs, so the events of one request come
// out in the order they happened.
plannerApi.patch(
  "/tasks/:id",
  zValidator("json", plannerUpdateTaskSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const {
        today,
        column,
        plan,
        effort,
        start_date,
        before_id,
        after_id,
        dropped,
        ...fields
      } = c.req.valid("json");
      plannerAssertToday(today, new Date());
      const { db, user } = context;
      const actor = plannerResolveActor(c, context.credential);
      const taskId = parseTaskId(c.req.param("id"));

      // The last planner step that ran holds the final task and plan, unless an
      // upstream edit came after it.
      let result: PlannerTaskPlanResponse | undefined;
      if (dropped === false) {
        result = await plannerUndropTask(db, { user, actor, taskId });
      }
      if (Object.keys(fields).length > 0) {
        await updateTask(db, user, actor, taskId, fields);
        result = undefined;
      }
      if (column !== undefined) {
        result = await plannerApplyColumnMove(db, {
          user,
          actor,
          taskId,
          to: column,
          today,
        });
        // Dropped between two cards: the column's order, one row, no event. The
        // schema guarantees `column` is set whenever an anchor is.
        if (before_id !== undefined || after_id !== undefined) {
          result = await plannerSetBoardRank(db, {
            user,
            taskId,
            column,
            beforeId: before_id,
            afterId: after_id,
            today,
          });
        }
      } else if (plan !== undefined) {
        result = await plannerSetPlan(db, {
          user,
          actor,
          taskId,
          plan,
          today,
        });
      }
      if (effort !== undefined) {
        result = await plannerSetEffort(db, { user, actor, taskId, effort });
      }
      if (start_date !== undefined) {
        result = await plannerSetStartDate(db, {
          user,
          actor,
          taskId,
          startDate: start_date,
        });
      }
      if (dropped === true) {
        result = await plannerDropTask(db, { user, actor, taskId });
      }

      // Upstream's updateTask returns only the task, so read the plan back when
      // nothing planner-side ran after it. Then pick just the two keys: a column
      // move's result also carries `from` and `to`, which are not on the wire.
      const final = result ?? (await plannerReadTaskPlan(db, { user, taskId }));
      const response: PlannerTaskPlanResponse = {
        task: final.task,
        plan: final.plan,
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// History reads sync the archive first, so an edit made through /projects or the
// API a moment ago is already in it. The sync never throws and may report
// `paused`; either way the archive is read, so its result is ignored here. A
// task that is gone (purged) still has its history, so an unknown task id is an
// empty list rather than a 404, and the read is scoped to the caller either way.
plannerApi.get("/tasks/:id/history", async (c) => {
  try {
    const { db, user } = await getRequestContext(c);
    await plannerSyncHistory(db, { userId: user.id, now: new Date() });
    const response: PlannerTaskHistoryResponse = {
      events: await plannerReadTaskHistory(db, {
        userId: user.id,
        taskId: parseTaskId(c.req.param("id")),
      }),
    };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

// --- Comments ---------------------------------------------------------------
//
// A task's comments live in planner_task_comment and are soft-deleted. A comment
// is the caller's own, and so is its task, so another user's comment id, a deleted
// one and one that never existed all answer 404. Every write is one batch with its
// history event (`commented`, `comment_edited`, `comment_deleted`), which carries
// the comment's id and never its text. DELETE is in the API's CORS allow-list
// (upstream's task delete uses it), so it is a real DELETE.

plannerApi.get("/tasks/:id/comments", async (c) => {
  try {
    const { db, user } = await getRequestContext(c);
    const response: PlannerCommentListResponse = {
      comments: await plannerListComments(db, {
        userId: user.id,
        taskId: parseTaskId(c.req.param("id")),
      }),
    };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

plannerApi.post(
  "/tasks/:id/comments",
  zValidator("json", plannerCreateCommentSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const { body } = c.req.valid("json");
      const response: PlannerCommentResponse = {
        comment: await plannerAddComment(context.db, {
          user: context.user,
          actor: plannerResolveActor(c, context.credential),
          taskId: parseTaskId(c.req.param("id")),
          body,
        }),
      };
      return c.json(response, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerApi.patch(
  "/comments/:id",
  zValidator("json", plannerUpdateCommentSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const { body } = c.req.valid("json");
      const response: PlannerCommentResponse = {
        comment: await plannerUpdateComment(context.db, {
          user: context.user,
          actor: plannerResolveActor(c, context.credential),
          commentId: c.req.param("id"),
          body,
        }),
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerApi.delete("/comments/:id", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    await plannerDeleteComment(context.db, {
      user: context.user,
      actor: plannerResolveActor(c, context.credential),
      commentId: c.req.param("id"),
    });
    const response: PlannerDeleteCommentResponse = { ok: true };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

plannerApi.get(
  "/history",
  zValidator("query", plannerHistoryRangeQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const { from, to } = c.req.valid("query");
      await plannerSyncHistory(db, { userId: user.id, now: new Date() });
      const response: PlannerHistoryRangeResponse =
        await plannerReadHistoryRange(db, { userId: user.id, from, to });
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// --- Goal tree --------------------------------------------------------------

plannerApi.get("/tree", async (c) => {
  try {
    const { db, user } = await getRequestContext(c);
    const response: PlannerTreeResponse = {
      nodes: await plannerReadTree(db, { userId: user.id }),
    };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

// PATCH, not PUT: the Worker's CORS allowMethods has no PUT. An omitted field is
// unchanged and `null` clears it, which is why the body is passed through as is.
plannerApi.patch(
  "/tree/:projectId",
  zValidator("json", plannerUpdateTreeNodeSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      const response: PlannerTreeNodeResponse = {
        node: await plannerUpsertProjectNode(context.db, {
          userId: context.user.id,
          projectId: c.req.param("projectId"),
          parentProjectId: body.parent_project_id,
          level: body.level,
          periodStart: body.period_start,
          periodEnd: body.period_end,
          sortOrder: body.sort_order,
        }),
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerApi.get(
  "/tree/:projectId/rollup",
  zValidator("query", plannerRollupQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const { from, to } = c.req.valid("query");
      const rollup: PlannerRollupResponse = await plannerReadRollup(db, {
        userId: user.id,
        projectId: c.req.param("projectId"),
        from,
        to,
      });
      return c.json(rollup);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// --- Goals and the weekly review --------------------------------------------

// Registered last, on the same sub-app, so the lazy mount and the JSON 404 above
// cover them too (planner-goals-api.ts).
plannerApi.route("/", plannerGoalsApi);
