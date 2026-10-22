import {
  plannerColumns,
  plannerCreateCommentSchema,
  plannerCreateTaskSchema,
  plannerHorizons,
  plannerUpdateTaskSchema,
} from "@flaremo/contracts";
import {
  parseResourceName,
  QuotaExceededError,
  ValidationError,
} from "@flaremo/domain";
import {
  plannerAddComment,
  plannerAddTask,
  plannerChangeTask,
  plannerReadBoard,
  plannerReadCockpitWeek,
  plannerReadTaskDetail,
  plannerReadTaskHistory,
  plannerSyncHistory,
} from "@flaremo/domain/src/planner";
import type { Context } from "hono";
import type { HonoBindings, ReturnTypeOfRequestContext } from "../context";
import type { JsonObject } from "../mcp-protocol";
import { checkRateLimit } from "../rate-limit";
import {
  plannerAssertToday,
  plannerResolveActor,
} from "../routes/planner-route-helpers";

// Cockpit tasks on the app's own MCP server (fork-owned add-on,
// docs/fork-customizations.md). Upstream's /mcp only knows memos, shortcuts and
// attachments, so a personal access token could reach the board over
// /api/app/planner but an agent connected over MCP could not see it at all.
// These tools are thin wrappers over the same domain calls planner-api.ts
// makes, under the same rules: the same request schemas, the same `today`
// bound, the same "planner" rate limit on writes, and the same `pat:` actor
// label, so every change lands in the permanent history archive exactly as a
// REST call would. Nothing here deletes or purges: a task is dropped (soft) with
// `dropped: true`, and comments are only added.
//
// Hook-in: routes/mcp/tool-schemas.ts appends `forkTaskMcpTools`, and
// routes/mcp/index.ts sends a `tools/call` whose name `forkIsTaskMcpTool`
// claims here before upstream's switch.

const DAY = {
  type: "string",
  description: "A day as YYYY-MM-DD.",
} as const;
const TODAY = {
  type: "string",
  description:
    "The user's local date (YYYY-MM-DD). Optional: defaults to today in UTC. Must be within one day of the server's date.",
} as const;
const TASK_ID = {
  type: "string",
  minLength: 1,
  description: "The task id as the board lists it (tasks/<id> or the bare id).",
} as const;
const COLUMN = {
  type: "string",
  enum: [...plannerColumns],
  description:
    "Board column: backlog, todo (To Do), doing or done. Moving a task sets its plan and status.",
} as const;
const PLAN = {
  type: ["object", "null"],
  properties: {
    horizon: { type: "string", enum: [...plannerHorizons] },
    day: DAY,
  },
  required: ["horizon", "day"],
  additionalProperties: false,
  description:
    "When the task is planned: a day, week or month containing `day`. null puts it back in the backlog.",
} as const;
const PRIORITY = {
  type: "string",
  enum: ["none", "low", "medium", "high"],
} as const;
const GOAL_ID = {
  type: ["string", "null"],
  description: "The weekly goal (planner goal id) the task serves, or null.",
} as const;

export const forkTaskMcpTools: Array<{
  name: string;
  description: string;
  inputSchema: JsonObject;
}> = [
  {
    name: "task_read_board",
    description:
      "Read the planning cockpit board: Backlog, To Do, Doing and recent Done tasks with their plans, goals and order, plus this week's goals.",
    inputSchema: {
      type: "object",
      properties: {
        today: TODAY,
        done_days: {
          type: "integer",
          minimum: 0,
          description: "How many days of Done tasks to include.",
        },
        include_dropped: {
          type: "boolean",
          description: "Also list dropped tasks.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "task_get_task",
    description:
      "Read one cockpit task in full: notes, plan, effort, start date, goal and comments.",
    inputSchema: {
      type: "object",
      properties: { id: TASK_ID },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "task_get_history",
    description:
      "Read a task's permanent history: every move, edit, goal change and comment event, newest first. Kept even after a task is deleted.",
    inputSchema: {
      type: "object",
      properties: { id: TASK_ID },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "task_create_task",
    description:
      "Add a task to the cockpit. Without a column or plan it lands in the Backlog.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 2000 },
        notes: { type: "string", maxLength: 20000 },
        priority: PRIORITY,
        due_at: DAY,
        column: COLUMN,
        plan: PLAN,
        goal_id: GOAL_ID,
        today: TODAY,
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  {
    name: "task_update_task",
    description:
      "Change a cockpit task: move it to another column (optionally between two cards with before_id/after_id), re-plan it, or edit its title, notes, priority, due date, effort, start date or goal. `dropped: true` drops it (it stays in history; `dropped: false` restores it). Send either column or plan, not both.",
    inputSchema: {
      type: "object",
      properties: {
        id: TASK_ID,
        column: COLUMN,
        before_id: {
          type: "string",
          description: "With column: the card that will sit directly below.",
        },
        after_id: {
          type: "string",
          description: "With column: the card that will sit directly above.",
        },
        plan: PLAN,
        title: { type: "string", minLength: 1, maxLength: 2000 },
        notes: { type: ["string", "null"], maxLength: 20000 },
        priority: PRIORITY,
        due_at: { type: ["string", "null"], description: DAY.description },
        effort: {
          type: ["number", "null"],
          minimum: 0,
          maximum: 999,
          description: "Effort estimate, at most one decimal place.",
        },
        start_date: {
          type: ["string", "null"],
          description: DAY.description,
        },
        goal_id: GOAL_ID,
        dropped: { type: "boolean" },
        today: TODAY,
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "task_add_comment",
    description: "Add a comment to a cockpit task.",
    inputSchema: {
      type: "object",
      properties: {
        id: TASK_ID,
        body: { type: "string", minLength: 1, maxLength: 5000 },
      },
      required: ["id", "body"],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = new Set(forkTaskMcpTools.map((tool) => tool.name));

export function forkIsTaskMcpTool(name: string): boolean {
  return TOOL_NAMES.has(name);
}

function taskId(args: JsonObject): string {
  const value = args.id;
  if (typeof value !== "string" || !value.trim()) {
    throw new ValidationError("id is required.");
  }
  return parseResourceName(value.trim(), "tasks");
}

function today(args: JsonObject): string {
  const value = args.today ?? new Date().toISOString().slice(0, 10);
  if (typeof value !== "string") {
    throw new ValidationError("today must be a YYYY-MM-DD string.");
  }
  plannerAssertToday(value, new Date());
  return value;
}

/** The REST routes answer 429; a tool call says the same as a tool error. */
async function throttle(
  c: Context<HonoBindings>,
  context: ReturnTypeOfRequestContext,
) {
  if (
    await checkRateLimit(
      c.env.RATE_LIMITER,
      "planner",
      c.req.raw,
      context.user.id,
    )
  ) {
    throw new QuotaExceededError("Too many requests. Please try again later.");
  }
}

export async function forkCallTaskMcpTool(
  c: Context<HonoBindings>,
  context: ReturnTypeOfRequestContext,
  name: string,
  args: JsonObject,
): Promise<unknown> {
  const { db, user } = context;
  switch (name) {
    case "task_read_board": {
      const day = today(args);
      const doneDays = args.done_days;
      if (
        doneDays !== undefined &&
        (typeof doneDays !== "number" || !Number.isInteger(doneDays))
      ) {
        throw new ValidationError("done_days must be a whole number.");
      }
      await plannerSyncHistory(db, { userId: user.id, now: new Date() });
      const [board, week] = await Promise.all([
        plannerReadBoard(db, {
          userId: user.id,
          today: day,
          doneDays,
          includeDropped: args.include_dropped === true,
        }),
        plannerReadCockpitWeek(db, { userId: user.id, today: day }),
      ]);
      return { ...board, week };
    }
    case "task_get_task":
      return plannerReadTaskDetail(db, {
        userId: user.id,
        taskId: taskId(args),
      });
    case "task_get_history":
      await plannerSyncHistory(db, { userId: user.id, now: new Date() });
      return {
        events: await plannerReadTaskHistory(db, {
          userId: user.id,
          taskId: taskId(args),
        }),
      };
    case "task_create_task": {
      const body = plannerCreateTaskSchema.parse({
        ...args,
        today: today(args),
      });
      await throttle(c, context);
      const created = await plannerAddTask(db, {
        user,
        actor: await plannerResolveActor(c, context.credential),
        title: body.title,
        notes: body.notes,
        priority: body.priority,
        dueAt: body.due_at,
        column: body.column,
        plan: body.plan,
        goalId: body.goal_id,
        today: body.today,
      });
      return {
        task: created.task,
        plan: created.plan,
        ...(created.planError ? { plan_error: created.planError } : {}),
        ...(created.goalError ? { goal_error: created.goalError } : {}),
      };
    }
    case "task_update_task": {
      const id = taskId(args);
      const { id: _id, ...rest } = args;
      const body = plannerUpdateTaskSchema.parse({
        ...rest,
        today: today(args),
      });
      await throttle(c, context);
      return plannerChangeTask(db, {
        user,
        actor: await plannerResolveActor(c, context.credential),
        taskId: id,
        today: body.today,
        change: {
          dropped: body.dropped,
          title: body.title,
          notes: body.notes,
          priority: body.priority,
          dueAt: body.due_at,
          column: body.column,
          beforeId: body.before_id,
          afterId: body.after_id,
          plan: body.plan,
          effort: body.effort,
          startDate: body.start_date,
          goalId: body.goal_id,
        },
      }).then((result) => ({ task: result.task, plan: result.plan }));
    }
    case "task_add_comment": {
      const id = taskId(args);
      const { body } = plannerCreateCommentSchema.parse({ body: args.body });
      await throttle(c, context);
      return {
        comment: await plannerAddComment(db, {
          user,
          actor: await plannerResolveActor(c, context.credential),
          taskId: id,
          body,
        }),
      };
    }
    default:
      throw new ValidationError(`Unknown tool: ${name}`);
  }
}
