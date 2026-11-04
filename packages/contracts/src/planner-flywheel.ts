// The flywheel's contracts (fork-owned add-on, docs/fork-flywheel.md). A log of
// changes to goals and review steps, a weekly scorecard that compares what the
// agent proposed with what the owner did on their own, and the owner's tuning
// of the agent, which the Sunday review shows and settles. Re-exported from
// planner.ts; it never imports planner.ts back.
//
//   GET    /flywheel/:week?today                PlannerFlywheelResponse
//   POST   /flywheel/:week/note                 PlannerFlywheelResponse
//   POST   /flywheel/:week/rebuild              PlannerFlywheelResponse
//   POST   /flywheel/:week/tuning/propose       PlannerFlywheelResponse
//   POST   /flywheel/:week/tuning/:id           PlannerFlywheelResponse
//
// `:week` is the reviewed week; every route answers with that week's card.
//
// Every export is prefixed planner/Planner.

import { z } from "zod";
import { plannerIsMonday } from "./planner-goals";

/**
 * The scorecard's numbers, in the order the page lists them. Each is a share
 * (0 to 1) of `den` unless `count` says it is a plain count or `cents` a sum of
 * money.
 */
export const plannerFlywheelMetrics = {
  proposals_seen: {
    label: "Proposals you saw",
    unit: "share",
    origins: ["ai"],
  },
  proposals_accepted: {
    label: "Proposals accepted",
    unit: "share",
    origins: ["ai"],
  },
  kept_7d: {
    label: "Kept 7 days",
    unit: "share",
    origins: ["ai"],
  },
  entries_edited_7d: {
    label: "Entries edited within 7 days",
    unit: "share",
    origins: ["ai", "manual"],
  },
  entry_edit_chars: {
    label: "Typical edit size",
    unit: "chars",
    origins: ["ai", "manual"],
  },
  tasks_done_by_due: {
    label: "Tasks done by due date",
    unit: "share",
    origins: ["ai", "manual", "all"],
  },
  tasks_carried: {
    label: "Tasks carried over",
    unit: "share",
    origins: ["ai", "manual", "all"],
  },
  goals_met: {
    label: "Week goals met",
    unit: "share",
    origins: ["ai", "manual", "all"],
  },
  goals_rewritten: {
    label: "Goal rewrites",
    unit: "count",
    origins: ["all"],
  },
  memo_rewrite_rate: {
    label: "Summary lines you rewrote",
    unit: "share",
    origins: ["all"],
  },
  cost_per_kept: {
    label: "Agent cost per kept proposal",
    unit: "cents",
    origins: ["ai"],
  },
} as const satisfies Record<
  string,
  {
    label: string;
    unit: "share" | "count" | "chars" | "cents";
    origins: readonly PlannerFlywheelOrigin[];
  }
>;

export type PlannerFlywheelOrigin = "ai" | "manual" | "all";
export type PlannerFlywheelMetric = keyof typeof plannerFlywheelMetrics;
export const plannerFlywheelMetricNames = Object.keys(
  plannerFlywheelMetrics,
) as PlannerFlywheelMetric[];

/** The three numbers the Sunday review opens on, with the origin each is read for. */
export const plannerFlywheelHeadline = [
  { metric: "proposals_accepted", origin: "ai" },
  { metric: "kept_7d", origin: "ai" },
  { metric: "tasks_done_by_due", origin: "ai" },
] as const satisfies ReadonlyArray<{
  metric: PlannerFlywheelMetric;
  origin: PlannerFlywheelOrigin;
}>;

/** Below this many cases a share is shown as "too few", never as a percentage. */
export const PLANNER_FLYWHEEL_MIN_SAMPLE = 10;
/** A tuning version is judged on this many days, and proposed at most this often. */
export const PLANNER_FLYWHEEL_TUNING_DAYS = 28;
/** The longest standing instructions the agent is given. */
export const plannerTuningInstructionsMax = 1_500;
/** The longest weekly note to the agent. */
export const plannerTuningNoteMax = 600;
/**
 * Proposing pauses when, over the 14 days before the last one, at least this
 * many proposals were made and fewer than one in ten was ever shown.
 */
export const PLANNER_FLYWHEEL_PAUSE_MIN = 10;

export type PlannerMetricValueDto = {
  metric: PlannerFlywheelMetric;
  origin: PlannerFlywheelOrigin;
  /** The share, count, size or cents; null when nothing was there to count. */
  value: number | null;
  num: number;
  den: number;
};

export type PlannerMetricWeekDto = {
  week_start: string;
  values: PlannerMetricValueDto[];
};

export type PlannerTuningDto = {
  id: string;
  /** 1, 2, ... once accepted; null while proposed. */
  version: number | null;
  instructions: string;
  why: string;
  metric: PlannerFlywheelMetric | null;
  baseline: number | null;
  state:
    | "proposed"
    | "active"
    | "kept"
    | "rolled_back"
    | "dismissed"
    | "superseded";
  proposed_by: "agent" | "owner";
  created_at: string;
  activated_at: string | null;
  judged_at: string | null;
};

/** The verdict card: a version four weeks on, against the number it aimed at. */
export type PlannerTuningVerdictDto = {
  tuning: PlannerTuningDto;
  metric: PlannerFlywheelMetric;
  before: number | null;
  after: number | null;
  /** Cases behind `after`; under PLANNER_FLYWHEEL_MIN_SAMPLE reads "too few". */
  after_den: number;
};

export type PlannerFlywheelResponse = {
  week_start: string;
  /** This week and the weeks before it, newest first, up to eight. */
  weeks: PlannerMetricWeekDto[];
  /** The version the agent follows now, if any. */
  current: PlannerTuningDto | null;
  /** A proposal waiting for the owner. */
  proposal: PlannerTuningDto | null;
  /** A version due for its keep or roll back. */
  verdict: PlannerTuningVerdictDto | null;
  /** No proposal in the last four weeks and none open: the page offers one. */
  proposal_due: boolean;
  /** The owner's note for this week, or null; `skipped` when they passed. */
  note: string | null;
  note_skipped: boolean;
  /** Days since the scorecard was last opened before this time; null if never. */
  last_viewed_days: number | null;
  /** The agent's proposing is paused: almost none of its proposals were seen. */
  proposing_paused: boolean;
  /** Whether a model is there to write a tuning proposal. */
  can_propose: boolean;
};

const mondaySchema = z
  .string()
  .refine(plannerIsMonday, "Expected a Monday, YYYY-MM-DD.");

export const plannerFlywheelQuerySchema = z.strictObject({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const plannerFlywheelWeekParamSchema = z.strictObject({
  week: mondaySchema,
});

export const plannerTuningSettleParamSchema = z.strictObject({
  week: mondaySchema,
  id: z.string().min(1).max(64),
});

/** The weekly note: words, or null to pass this week. */
export const plannerTuningNoteSchema = z.strictObject({
  note: z.string().trim().max(plannerTuningNoteMax).nullable(),
});

/** Settles a tuning row: a proposal (accept, with optional edits, or dismiss) or a verdict. */
export const plannerTuningSettleSchema = z.strictObject({
  decision: z.enum(["accept", "dismiss", "keep", "roll_back"]),
  /** On accept: the instructions as the owner edited them. */
  instructions: z.string().trim().max(plannerTuningInstructionsMax).optional(),
});

/** The owner writes a version themselves. */
export const plannerTuningProposeSchema = z.strictObject({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Given: the owner's own version, filed as a proposal to accept. */
  instructions: z
    .string()
    .trim()
    .min(1)
    .max(plannerTuningInstructionsMax)
    .optional(),
});
