import {
  type PlannerFlywheelResponse,
  plannerFlywheelQuerySchema,
  plannerFlywheelWeekParamSchema,
  plannerTuningNoteSchema,
  plannerTuningProposeSchema,
  plannerTuningSettleParamSchema,
  plannerTuningSettleSchema,
} from "@flaremo/contracts";
import {
  plannerAddTuningProposal,
  plannerCurrentTuning,
  plannerFlywheelRollup,
  plannerParseTuningProposal,
  plannerReadFlywheel,
  plannerReadScorecard,
  plannerRecentTuningNotes,
  plannerSaveTuningNote,
  plannerSettleTuning,
  plannerTuningProposalMessages,
} from "@flaremo/domain/src/planner";
import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import { getRequestContext, type HonoBindings } from "../context";
import { jsonError } from "../http";
import { rateLimitGuard } from "../rate-limit";
import { plannerLogModelError, plannerReviewModel } from "./planner-review-ai";
import { plannerAssertToday } from "./planner-route-helpers";

// The flywheel over HTTP (fork-owned add-on, docs/fork-flywheel.md; the routes
// are listed in packages/contracts/src/planner-flywheel.ts): the Sunday
// review's scorecard card, the owner's weekly note to the agent, and the
// tuning proposals and verdicts. planner-api.ts mounts this sub-app, so it
// shares that file's lazy mount, authentication and JSON 404. The work is the
// domain's (packages/domain/src/planner/flywheel.ts); the one model call, the
// tuning proposal, uses the weekly review's model.

export const plannerFlywheelApi = new Hono<HonoBindings>();

const AI_UNAVAILABLE = {
  error: {
    message: "No model is set up to write a proposal.",
    code: "ai_unavailable",
  },
};

async function respond(
  c: Context<HonoBindings>,
  userId: string,
  weekStart: string,
) {
  const { db } = await getRequestContext(c);
  const response: PlannerFlywheelResponse = await plannerReadFlywheel(db, {
    userId,
    weekStart,
    canPropose: plannerReviewModel(c.env) !== null,
  });
  return c.json(response);
}

plannerFlywheelApi.get(
  "/flywheel/:week",
  zValidator("param", plannerFlywheelWeekParamSchema),
  zValidator("query", plannerFlywheelQuerySchema),
  async (c) => {
    try {
      const { user } = await getRequestContext(c);
      plannerAssertToday(c.req.valid("query").today, new Date());
      return await respond(c, user.id, c.req.valid("param").week);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerFlywheelApi.post(
  "/flywheel/:week/note",
  zValidator("param", plannerFlywheelWeekParamSchema),
  zValidator("json", plannerTuningNoteSchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", user.id);
      if (throttled) return throttled;
      const { week } = c.req.valid("param");
      await plannerSaveTuningNote(db, {
        userId: user.id,
        weekStart: week,
        note: c.req.valid("json").note,
      });
      return await respond(c, user.id, week);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerFlywheelApi.post(
  "/flywheel/:week/rebuild",
  zValidator("param", plannerFlywheelWeekParamSchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", user.id);
      if (throttled) return throttled;
      const { week } = c.req.valid("param");
      await plannerFlywheelRollup(db, {
        userId: user.id,
        weekStart: week,
        now: new Date(),
      });
      return await respond(c, user.id, week);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// Registered before /flywheel/:week/tuning/:id so "propose" is never read as an id.
plannerFlywheelApi.post(
  "/flywheel/:week/tuning/propose",
  zValidator("param", plannerFlywheelWeekParamSchema),
  zValidator("json", plannerTuningProposeSchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const { today, instructions } = c.req.valid("json");
      plannerAssertToday(today, new Date());
      const weekStart = c.req.valid("param").week;
      if (instructions) {
        const throttled = await rateLimitGuard(c, "planner", user.id);
        if (throttled) return throttled;
        await plannerAddTuningProposal(db, {
          userId: user.id,
          instructions,
          why: "",
          metric: null,
          proposedBy: "owner",
        });
        return await respond(c, user.id, weekStart);
      }
      const throttled = await rateLimitGuard(c, "planner-ai", user.id);
      if (throttled) return throttled;
      const model = plannerReviewModel(c.env);
      if (!model) return c.json(AI_UNAVAILABLE, 503);
      const [current, weeks, notes] = await Promise.all([
        plannerCurrentTuning(db, user.id),
        plannerReadScorecard(db, { userId: user.id, weekStart, weeks: 8 }),
        plannerRecentTuningNotes(db, { userId: user.id, weekStart, weeks: 8 }),
      ]);
      let raw: string;
      try {
        raw = await model.complete(
          plannerTuningProposalMessages({
            ownerName: user.name || "the owner",
            current,
            weeks,
            notes,
          }),
          { maxTokens: 1_200, temperature: 0.3, signal: c.req.raw.signal },
        );
      } catch (error) {
        plannerLogModelError(model, "tuning-proposal", error);
        return c.json(AI_UNAVAILABLE, 503);
      }
      const parsed = plannerParseTuningProposal(raw);
      if (!parsed) return c.json(AI_UNAVAILABLE, 503);
      await plannerAddTuningProposal(db, {
        userId: user.id,
        ...parsed,
        proposedBy: "agent",
        model: model.model,
      });
      return await respond(c, user.id, weekStart);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerFlywheelApi.post(
  "/flywheel/:week/tuning/:id",
  zValidator("param", plannerTuningSettleParamSchema),
  zValidator("json", plannerTuningSettleSchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", user.id);
      if (throttled) return throttled;
      const { week, id } = c.req.valid("param");
      const body = c.req.valid("json");
      await plannerSettleTuning(db, {
        userId: user.id,
        id,
        decision: body.decision,
        instructions: body.instructions,
      });
      return await respond(c, user.id, week);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);
