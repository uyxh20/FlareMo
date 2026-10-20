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
//   GET    /ask?today[&conversation]            PlannerAskResponse
//   POST   /ask                                 PlannerAskResponse
//   POST   /ask/:conversation/end               PlannerOkResponse
//
// Every export is prefixed planner/Planner.

import { z } from "zod";
import {
  plannerGoalLineSchema,
  plannerIsDay,
  plannerIsMonday,
  plannerPillarSchema,
} from "./planner-goals";
import { plannerPeriodLevelSchema } from "./planner-period-review";

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
    why: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe("One or two sentences: what in the record this answers."),
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
        "The goal it serves: an existing goal's id, or the id propose_goal returned.",
      ),
    why: z.string().trim().min(1).max(500),
    quote: quoteSchema.optional(),
    entry_id: entryIdSchema.optional(),
  }),
} as const;

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
};

/** The tools that write a proposal: off in every session but a review's. */
export const plannerAgentProposeTools = [
  "propose_memory",
  "propose_goal",
  "propose_task",
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
  /** A task's goal: an existing goal's id or a goal proposal's id. */
  goal_ref: z.string().nullable(),
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
};

export type PlannerAgentProposalResponse = {
  proposal: PlannerAgentProposalDto;
};

/** Accept a proposal into the plan, or dismiss it. */
export const plannerAgentSettleSchema = z.strictObject({
  state: z.enum(["accepted", "dismissed", "open"]),
});

export const plannerAskQuerySchema = z.object({
  today: daySchema,
  conversation: z.uuid().optional(),
});

export const plannerAskSchema = z.strictObject({
  today: daySchema,
  /** The conversation to go on with; a new one starts without it. */
  conversation: z.uuid().optional(),
  text: z.string().trim().min(1).max(4000),
});

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
  messages: PlannerAskMessage[];
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
