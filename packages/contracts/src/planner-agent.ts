// The general agent's contracts (fork-owned add-on, docs/fork-general-agent.md).
// One Claude Managed Agent reads the whole record over its own read-only MCP
// server (`/api/app/planner/agent/mcp`) and writes nothing but proposals. This
// file holds what the Worker, the web app and the setup and eval scripts share:
// the MCP tools' names and inputs, and the HTTP API under `/api/app/planner`
// for the Ask chat and the review's proposals. Re-exported from planner.ts;
// it never imports planner.ts back.
//
//   GET    /review/:week/proposals?today        PlannerAgentProposalsResponse
//   POST   /review/:week/proposals              PlannerAgentProposalsResponse
//   POST   /agent/proposals/:id                 PlannerAgentProposalResponse
//   GET    /ask?today[&conversation][&task]     PlannerAskResponse
//   POST   /ask                                 PlannerAskResponse
//   POST   /ask/:conversation/end               PlannerOkResponse
//   POST   /agent/actions/:id                   PlannerAgentActionResponse
//
// Every export is prefixed planner/Planner.

import { z } from "zod";
import { plannerColumns } from "./planner-board";
import {
  plannerGoalLineSchema,
  plannerIsDay,
  plannerIsMonday,
  plannerPillarSchema,
} from "./planner-goals";
import { plannerPeriodLevelSchema } from "./planner-period-review";
import { taskPrioritySchema } from "./projects";

// planner.ts re-exports this file and defines plannerColumnSchema, so the enum
// is built here from the same list instead of importing it back.
const columnSchema = z.enum(plannerColumns);

const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(plannerIsDay, "Expected a real YYYY-MM-DD date.");

const mondaySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(plannerIsMonday, "Expected the Monday of a week, YYYY-MM-DD.");

const idSchema = z.string().trim().min(1).max(100);

/** Words copied from the owner's diary, which the server finds word for word. */
const quoteSchema = z
  .string()
  .trim()
  .min(12)
  .max(600)
  .describe(
    "At least a few words copied exactly from one diary entry, no edits, no ellipsis. The server looks for them word for word and refuses the proposal when they are not there.",
  );

const entryIdSchema = idSchema.describe(
  "The id of the diary entry the quote is from, when you know it.",
);

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

/** The agent's MCP server's name on the agent, and its path on the Worker. */
export const PLANNER_AGENT_MCP_SERVER = "diary";
export const PLANNER_AGENT_MCP_PATH = "/api/app/planner/agent/mcp";

/**
 * The name of the agent's personal access token. A key with this name opens
 * the agent's MCP server and nothing else (apps/worker/src/fork/agent-key.ts).
 */
export const PLANNER_AGENT_KEY_NAME = "Schizo Diary agent (read-only)";

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

/**
 * Each tool's input. The read tools read; the three `propose_` tools are the
 * agent's only writes, and each lands as a proposal the owner decides on.
 */
export const plannerAgentToolInputs = {
  review_week: z.strictObject({
    week: mondaySchema.describe("The Monday of the week, YYYY-MM-DD."),
  }),
  review_period: z.strictObject({
    level: plannerPeriodLevelSchema,
    period_start: daySchema.describe(
      "The first day of the month, quarter or year, YYYY-MM-DD.",
    ),
  }),
  week_diary: z.strictObject({
    week: mondaySchema.describe("The Monday of the week, YYYY-MM-DD."),
  }),
  list_entries: z.strictObject({
    from: daySchema.describe("The first day, YYYY-MM-DD."),
    to: daySchema.describe("The last day, YYYY-MM-DD, at most 400 days on."),
  }),
  read_entries: z.strictObject({
    ids: z.array(idSchema).min(1).max(20).describe("Entry ids, up to 20."),
  }),
  search_entries: z.strictObject({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe("Words to find; every word must be in the entry."),
    from: daySchema.optional().describe("Only entries written on or after."),
    to: daySchema.optional().describe("Only entries written on or before."),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  read_goals: z.strictObject({
    year: z
      .number()
      .int()
      .min(2000)
      .max(2100)
      .optional()
      .describe("The year; this year when left out."),
  }),
  read_tasks: z.strictObject({
    done_days: z
      .number()
      .int()
      .min(0)
      .max(90)
      .optional()
      .describe("How many days of done tasks to include; 14 when left out."),
  }),
  read_task: z.strictObject({
    task_id: idSchema.describe("The task's id, as read_tasks lists it."),
  }),
  read_health: z.strictObject({
    from: daySchema.describe("The first day, YYYY-MM-DD."),
    to: daySchema.describe("The last day, YYYY-MM-DD, at most 26 weeks on."),
  }),
  read_memories: z.strictObject({
    query: z
      .string()
      .trim()
      .max(200)
      .optional()
      .describe("Words to find; every memory when left out."),
  }),
  propose_memory: z.strictObject({
    content: z
      .string()
      .trim()
      .min(1)
      .max(600)
      .describe(
        "One durable fact about the owner, in one or two plain sentences.",
      ),
    kind: z.enum(["fact", "preference", "decision", "constraint", "lesson"]),
    quote: quoteSchema,
    entry_id: entryIdSchema.optional(),
  }),
  propose_goal: z.strictObject({
    week: mondaySchema.describe(
      "The Monday of the week being planned, YYYY-MM-DD.",
    ),
    pillar: plannerPillarSchema,
    title: z.string().trim().min(1).max(300),
    lines: z.array(z.string().trim().min(1).max(300)).max(6).optional(),
    serves: idSchema
      .optional()
      .describe(
        "The month or quarter goal this week's goal is the next step on: its id from read_goals. Leave it out only when the objective has no month or quarter goal, and say so in why.",
      ),
    why: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "One or two sentences: where the month or quarter goal it serves stands (its struck and open points) and why this is the next step, with what in the record shows it.",
      ),
    quote: quoteSchema.optional(),
    entry_id: entryIdSchema.optional(),
  }),
  propose_task: z.strictObject({
    week: mondaySchema.describe(
      "The Monday of the week being planned, YYYY-MM-DD.",
    ),
    title: z.string().trim().min(1).max(300),
    pillar: plannerPillarSchema.optional(),
    goal_ref: idSchema
      .optional()
      .describe(
        "The goal it serves: an existing goal's id from read_goals (best the month or quarter goal it moves), or the id propose_goal returned. Set pillar to the objective of the week's goal it belongs under.",
      ),
    why: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe(
        "One or two sentences: which week goal and which month or quarter goal it moves, and why now.",
      ),
    quote: quoteSchema.optional(),
    entry_id: entryIdSchema.optional(),
  }),
  propose_task_change: z
    .strictObject({
      task_id: idSchema.describe("The task to change, by id."),
      title: z.string().trim().min(1).max(2000).optional(),
      notes: z
        .string()
        .trim()
        .min(1)
        .max(20_000)
        .optional()
        .describe(
          "The whole notes text as it should read afterwards (it replaces the notes; keep what the owner wrote unless the owner asked to change it).",
        ),
      priority: taskPrioritySchema.optional(),
      due_at: daySchema.optional().describe("The due day, YYYY-MM-DD."),
      effort: z.number().min(0).max(999).optional(),
      start_date: daySchema.optional().describe("The start day, YYYY-MM-DD."),
      column: columnSchema
        .optional()
        .describe("backlog, todo, doing or done: moves the task there."),
      why: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe(
          "One or two sentences: why, with what in the record shows it.",
        ),
    })
    .refine(
      (value) =>
        plannerAgentActionFields.filter((field) => value[field] !== undefined)
          .length === 1,
      {
        message:
          "Propose exactly one field per call: title, notes, priority, due_at, effort, start_date or column.",
        path: ["task_id"],
      },
    ),
  propose_add_task: z.strictObject({
    title: z.string().trim().min(1).max(2000),
    notes: z.string().trim().min(1).max(20_000).optional(),
    priority: taskPrioritySchema.optional(),
    due_at: daySchema.optional().describe("The due day, YYYY-MM-DD."),
    column: columnSchema
      .optional()
      .describe("backlog (the default), todo, doing or done."),
    why: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("One or two sentences: why this task, and why now."),
  }),
  propose_entry: z.strictObject({
    content: z
      .string()
      .trim()
      .min(1)
      .max(20_000)
      .describe(
        "The diary entry as it should be saved, in the owner's voice, with #tags where the owner would use them.",
      ),
    why: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("One sentence: what the owner asked for."),
  }),
} as const;

/** The task fields one propose_task_change call may set, one at a time. */
export const plannerAgentActionFields = [
  "title",
  "notes",
  "priority",
  "due_at",
  "effort",
  "start_date",
  "column",
] as const;
export type PlannerAgentActionField = (typeof plannerAgentActionFields)[number];

export type PlannerAgentToolName = keyof typeof plannerAgentToolInputs;
export type PlannerAgentToolInput<N extends PlannerAgentToolName> = z.infer<
  (typeof plannerAgentToolInputs)[N]
>;

/** What each tool is for, as the agent reads it. Order is the listing order. */
export const plannerAgentToolDescriptions: Record<
  PlannerAgentToolName,
  string
> = {
  review_week:
    "The weekly review's focus in one read: the goal cascade, eight weeks of scores, last week's key question, Next Steps and summary, the task board with the week's task details, the health tracker's week, the memories made that week, every diary entry of the week whole, and an index of those entries with their ids. Read it first in a weekly review.",
  review_period:
    "A month, quarter or year review's focus in one read: the period's goals and results, every week of it with its scores, verdict and saved summary, its diary, and the health totals.",
  week_diary:
    "One earlier week, whole: every diary entry written in it, with ids, and its saved weekly summary. Summaries were written by a model; check them against the diary.",
  list_entries:
    "The entry index: one line per diary entry written between two days, oldest first: its id, when it was written, who wrote it (the owner, or a review memo a model wrote), its length and its first words. Find what to open here, then read it with read_entries.",
  read_entries: "Diary entries in full, by id, up to 20 at a time.",
  search_entries:
    "Full-text search over every diary entry ever written: the ids, days and a snippet of the entries holding every word, newest first. Use it to answer 'when did this last happen' before claiming it never did.",
  read_goals:
    "Every goal of a year, with ids: the north star, the year, quarter, month and week goals by objective, their lines, status, results and notes, and every recorded week of the year with its two scores, key question and verdict.",
  read_tasks:
    "The task board: Doing, To Do, recently done and Backlog tasks with their ids, the week or month each is planned for, due day, done time, goal, project and how often it was carried over.",
  read_task:
    "One task in full: its title, notes, column, plan, due day, priority, effort, start day, goal, comments and history. Read it before proposing a change to it.",
  read_health:
    "The health tracker between two days: each training session, breathwork and night out by day, and each week's totals against the owner's targets.",
  read_memories:
    "What the memory ledger already holds about the owner: each memory with its kind and whether the owner confirmed it or it waits as a proposal. Check here before proposing a memory.",
  propose_memory:
    "Propose a memory about the owner. It waits on the Memory page until the owner accepts or rejects it; nothing is remembered before that. Only in a review, only for something durable that the diary states, with the owner's own words as the receipt.",
  propose_goal:
    "Propose a weekly goal for the week being planned. It shows on the review page next to the plan; the owner adds it or dismisses it. Only in a weekly review's propose step. Returns the proposal's id, which propose_task can name as its goal.",
  propose_task:
    "Propose a task for the week being planned. It shows on the review page; the owner adds it or dismisses it. Only in a weekly review's propose step.",
  propose_task_change:
    "Propose one change to one task: new notes, a title, a priority, a due day, an effort, a start day or a column move. It shows as a card in the owner's chat; the owner accepts it (which writes it) or dismisses it. One field per call. Only in an Ask chat, at most 30 proposals a day.",
  propose_add_task:
    "Propose a new task for the board. It shows as a card the owner accepts or dismisses; nothing is added before that. Only in an Ask chat, at most 30 proposals a day.",
  propose_entry:
    "Propose a new diary entry in the owner's words, when the owner asks you to write one. It shows as a card; the owner accepts it (which saves it as an entry) or dismisses it. Never for editing an existing entry. Only in an Ask chat, at most 30 proposals a day.",
};

/** The tools that write a review proposal: off in every session but a review's. */
export const plannerAgentProposeTools = [
  "propose_memory",
  "propose_goal",
  "propose_task",
] as const satisfies readonly PlannerAgentToolName[];

/** The tools that propose an action: taken only in an Ask chat. */
export const plannerAgentActionTools = [
  "propose_task_change",
  "propose_add_task",
  "propose_entry",
] as const satisfies readonly PlannerAgentToolName[];

/** Every tool, in listing order, with its JSON Schema input. */
export function plannerAgentToolList(): Array<{
  name: PlannerAgentToolName;
  description: string;
  inputSchema: Record<string, unknown>;
}> {
  return (Object.keys(plannerAgentToolInputs) as PlannerAgentToolName[]).map(
    (name) => {
      const schema = z.toJSONSchema(plannerAgentToolInputs[name], {
        io: "input",
        unrepresentable: "any",
      }) as Record<string, unknown>;
      delete schema.$schema;
      return {
        name,
        description: plannerAgentToolDescriptions[name],
        inputSchema: schema,
      };
    },
  );
}

// ---------------------------------------------------------------------------
// HTTP API
// ---------------------------------------------------------------------------

export const plannerAgentProposalKinds = ["goal", "task"] as const;
export const plannerAgentProposalStates = [
  "open",
  "accepted",
  "dismissed",
] as const;

export const plannerAgentProposalDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(plannerAgentProposalKinds),
  /** The Monday of the week being planned. */
  week_start: z.string(),
  pillar: plannerPillarSchema.nullable(),
  title: z.string(),
  lines: z.array(plannerGoalLineSchema),
  /**
   * A task's goal: an existing goal's id or a goal proposal's id. A goal's:
   * the month or quarter goal it is the next step on.
   */
  goal_ref: z.string().nullable(),
  /** For a goal: the month or quarter goal it serves, as the page shows it. */
  serves: z
    .object({
      level: z.enum(["month", "quarter"]),
      period_start: z.string(),
      title: z.string(),
    })
    .nullable(),
  why: z.string(),
  /** The owner's words it rests on, found word for word, or null. */
  quote: z.string().nullable(),
  source_day: z.string().nullable(),
  state: z.enum(plannerAgentProposalStates),
});
export type PlannerAgentProposalDto = z.infer<
  typeof plannerAgentProposalDtoSchema
>;

export type PlannerAgentProposalsResponse = {
  proposals: PlannerAgentProposalDto[];
  /** The agent is still at work in the review's session: more may come. */
  pending: boolean;
  /** The general agent is set up here, so the page can ask it to propose. */
  agent: boolean;
  /** While pending: whether the agent drafts goals or tasks. */
  drafting: "goals" | "tasks" | null;
};

/**
 * Ask the agent to propose for the week being planned: goals (Choose the
 * week), or tasks for the goals the owner chose (Plan tasks).
 */
export const plannerSuggestProposalsSchema = z.object({
  today: daySchema,
  kind: z.enum(["goals", "tasks"]).default("goals"),
  /** For tasks: the week's goals as the plan stands, not yet saved. */
  goals: z
    .array(
      z.object({
        pillar: plannerPillarSchema.nullable(),
        title: z.string().trim().min(1).max(1000),
      }),
    )
    .max(12)
    .default([]),
});
export type PlannerSuggestProposalsInput = z.input<
  typeof plannerSuggestProposalsSchema
>;

export type PlannerAgentProposalResponse = {
  proposal: PlannerAgentProposalDto;
};

/** Accept a proposal into the plan, or dismiss it. */
export const plannerAgentSettleSchema = z.strictObject({
  state: z.enum(["accepted", "dismissed", "open"]),
});

const taskIdSchema = z.string().trim().min(1).max(256);

export const plannerAskQuerySchema = z.object({
  today: daySchema,
  conversation: z.uuid().optional(),
  /** A task's own chat: the latest conversation held from that task. */
  task: taskIdSchema.optional(),
});

export const plannerAskSchema = z.strictObject({
  today: daySchema,
  /** The conversation to go on with; a new one starts without it. */
  conversation: z.uuid().optional(),
  /** The task a new conversation is about (a task's own chat). */
  task: taskIdSchema.optional(),
  text: z.string().trim().min(1).max(4000),
});

// ---------------------------------------------------------------------------
// Proposed actions (migration 9015)
// ---------------------------------------------------------------------------

export const plannerAgentActionKinds = [
  "task_change",
  "task_new",
  "entry_new",
] as const;
export const plannerAgentActionStates = [
  "open",
  "accepted",
  "dismissed",
  "expired",
  "reverted",
] as const;

/** An action the agent proposed, as the chat shows it on a card. */
export const plannerAgentActionDtoSchema = z.object({
  id: z.string(),
  kind: z.enum(plannerAgentActionKinds),
  /** For a task change: the task; for a new task once accepted: the task made. */
  task_id: z.string().nullable(),
  /** For a task change: which field. */
  field: z.enum(plannerAgentActionFields).nullable(),
  /** The proposed value(s): `{ notes }`, `{ title, due_at, … }` or `{ content }`. */
  change: z.record(z.string(), z.unknown()),
  why: z.string(),
  state: z.enum(plannerAgentActionStates),
  /** The task or entry the accept wrote, once accepted. */
  landed_id: z.string().nullable(),
  created_at: z.string(),
});
export type PlannerAgentActionDto = z.infer<typeof plannerAgentActionDtoSchema>;

/** Accept an action (which writes it) or dismiss it. */
export const plannerAgentSettleActionSchema = z.strictObject({
  state: z.enum(["accepted", "dismissed"]),
  today: daySchema,
});

export type PlannerAgentActionResponse = {
  action: PlannerAgentActionDto;
};

/** At most this many proposed actions a day; the agent is told when it is used up. */
export const PLANNER_AGENT_ACTIONS_PER_DAY = 30;
/** An open action older than this is expired by the nightly sweep. */
export const PLANNER_AGENT_ACTION_DAYS = 7;

export type PlannerAskMessage = {
  id: string;
  role: "owner" | "agent";
  text: string;
  created_at: string;
};

export type PlannerAskResponse = {
  /** False when the agent is not set up on this deployment. */
  enabled: boolean;
  conversation: string | null;
  /** The task the conversation is held from, or null for the global chat. */
  task: string | null;
  messages: PlannerAskMessage[];
  /** The actions the agent proposed in this conversation, oldest first. */
  actions: PlannerAgentActionDto[];
  /**
   * `running` while the agent works on the last question; `failed` when it
   * stopped without an answer (the page offers to ask again).
   */
  status: "idle" | "running" | "failed";
};

/**
 * Why the agent cannot take a job right now: not set up, or this month's
 * spend cap (FLAREMO_AGENT_MONTH_USD) is used up. Sent as a 503's error code.
 */
export const plannerAgentUnavailableCodes = [
  "ai_unavailable",
  "agent_month_cap",
] as const;
