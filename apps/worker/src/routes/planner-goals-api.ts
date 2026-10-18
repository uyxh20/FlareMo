import {
  type PlannerAgentProposalResponse,
  type PlannerAgentProposalsResponse,
  type PlannerAgentResponse,
  type PlannerAiCheckResponse,
  type PlannerAiCloseResponse,
  type PlannerAiOpeningResponse,
  type PlannerAiStreamLine,
  type PlannerCommitResponse,
  type PlannerGoalResponse,
  type PlannerGoalsYearResponse,
  type PlannerLookBackResponse,
  type PlannerOkResponse,
  type PlannerReviewResponse,
  type PlannerReviewStateResponse,
  type PlannerReviewStatusResponse,
  plannerAddDays,
  plannerAgentSettleSchema,
  plannerAiCheckSchema,
  plannerAiCloseSchema,
  plannerAiCoachSchema,
  plannerAiMemoSchema,
  plannerAiOpeningSchema,
  plannerCommitSchema,
  plannerCreateGoalSchema,
  plannerGoalsQuerySchema,
  plannerLookBackSchema,
  plannerReviewQuerySchema,
  plannerReviewStatusQuerySchema,
  plannerSaveReviewStateSchema,
  plannerUpdateGoalSchema,
  plannerWeekCode,
} from "@flaremo/contracts";
import {
  PLANNER_AGENT_DIARY_CHARS,
  PLANNER_DIARY_CHARS,
  PLANNER_DIARY_CHARS_SMALL,
  type PlannerChatMessage,
  type PlannerCheckGoal,
  type PlannerCoachMode,
  type PlannerReviewAnswers,
  type PlannerReviewContext,
  plannerAgentCheckMessage,
  plannerAgentClaimStep,
  plannerAgentClearOpenProposals,
  plannerAgentCloseMessage,
  plannerAgentCoachMessage,
  plannerAgentFindOpenRun,
  plannerAgentListProposals,
  plannerAgentMemoKickoff,
  plannerAgentMemoMessage,
  plannerAgentOpeningMessage,
  plannerAgentProposeMessage,
  plannerAgentSettleProposal,
  plannerAgentWeekKey,
  plannerCheckMessages,
  plannerCloseMessages,
  plannerCoachMessages,
  plannerCoachStreamFilter,
  plannerCommitPlan,
  plannerCreateGoal,
  plannerDeleteGoal,
  plannerMemoMessages,
  plannerMemoStreamFilter,
  plannerOpeningMessages,
  plannerParseCheck,
  plannerParseClose,
  plannerParseWeekOpening,
  plannerReadFlags,
  plannerReadGoalsYear,
  plannerReadReview,
  plannerReadReviewContext,
  plannerResolveReviewWeek,
  plannerReviewStatus,
  plannerSaveLookBack,
  plannerSaveReviewState,
  plannerStartReviewOver,
  plannerUpdateGoal,
} from "@flaremo/domain/src/planner";
import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import { Hono } from "hono";
import {
  getRequestContext,
  type HonoBindings,
  type ReturnTypeOfRequestContext,
} from "../context";
import { jsonError } from "../http";
import { rateLimitGuard } from "../rate-limit";
import {
  type PlannerAgent,
  type PlannerAgentState,
  PlannerAgentUnavailableError,
  plannerAgent,
  plannerEndAgent,
  plannerLogAgentError,
  plannerPollAgent,
  plannerReadAgentMemo,
  plannerSendAgent,
  plannerStartAgent,
} from "./planner-agent";
import {
  type PlannerModelOptions,
  type PlannerReviewModel,
  plannerLogModelError,
  plannerReviewModel,
} from "./planner-review-ai";
import {
  plannerAssertToday,
  plannerResolveActor,
} from "./planner-route-helpers";

// Goals, week records and the weekly review over HTTP (fork-owned add-on,
// docs/planning-cockpit-goals-review.md; the routes are listed in
// packages/contracts/src/planner-goals.ts). planner-api.ts mounts this sub-app,
// so it shares that file's lazy mount, authentication and JSON 404.
//
// Like the rest of the planner API the routes only validate, authenticate,
// throttle and serialise. The AI routes add the model call: the prompts and the
// parsers are the domain's, and the model is planner-review-ai.ts's. Writes use
// the `planner` rate-limit bucket, the page's autosave its own, and model calls
// `planner-ai`, so a busy chat never blocks a save.

export const plannerGoalsApi = new Hono<HonoBindings>();

type RequestContext = ReturnTypeOfRequestContext;

/** The NDJSON response type of the two streaming routes. */
const NDJSON_HEADERS = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const AI_UNAVAILABLE = {
  error: {
    message: "The weekly review's model is not available.",
    code: "ai_unavailable",
  },
};

// --- Goals and weeks ----------------------------------------------------------

plannerGoalsApi.get(
  "/goals",
  zValidator("query", plannerGoalsQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const query = c.req.valid("query");
      plannerAssertToday(query.today, new Date());
      const response: PlannerGoalsYearResponse = await plannerReadGoalsYear(
        db,
        { userId: user.id, year: query.year, today: query.today },
      );
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerGoalsApi.post(
  "/goals",
  zValidator("json", plannerCreateGoalSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      const response: PlannerGoalResponse = {
        goal: await plannerCreateGoal(context.db, {
          userId: context.user.id,
          goal: {
            id: body.id,
            level: body.level,
            periodStart: body.period_start,
            pillar: body.pillar,
            title: body.title,
            lines: body.lines,
            status: body.status,
            note: body.note,
            result: body.result,
            sortOrder: body.sort_order,
          },
        }),
      };
      return c.json(response, 201);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// An omitted field is unchanged and `null` clears it.
plannerGoalsApi.patch(
  "/goals/:id",
  zValidator("json", plannerUpdateGoalSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      const response: PlannerGoalResponse = {
        goal: await plannerUpdateGoal(context.db, {
          userId: context.user.id,
          goalId: c.req.param("id"),
          patch: {
            pillar: body.pillar,
            title: body.title,
            lines: body.lines,
            status: body.status,
            note: body.note,
            result: body.result,
            sortOrder: body.sort_order,
          },
        }),
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerGoalsApi.delete("/goals/:id", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    await plannerDeleteGoal(context.db, {
      userId: context.user.id,
      goalId: c.req.param("id"),
    });
    const response: PlannerOkResponse = { ok: true };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

// --- The weekly review ----------------------------------------------------------

plannerGoalsApi.get(
  "/review",
  zValidator("query", plannerReviewQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const query = c.req.valid("query");
      plannerAssertToday(query.today, new Date());
      const response: PlannerReviewResponse = await plannerReadReview(db, {
        userId: user.id,
        today: query.today,
        week: query.week,
        ai: plannerReviewModel(c.env) !== null || plannerAgent(c.env) !== null,
      });
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerGoalsApi.get(
  "/review/status",
  zValidator("query", plannerReviewStatusQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const query = c.req.valid("query");
      plannerAssertToday(query.today, new Date());
      const response: PlannerReviewStatusResponse = await plannerReviewStatus(
        db,
        { userId: user.id, today: query.today },
      );
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// The page saves its progress as it goes, so it has its own bucket.
plannerGoalsApi.patch(
  "/review/:week/state",
  zValidator("json", plannerSaveReviewStateSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(
        c,
        "planner-review-state",
        context.user.id,
      );
      if (throttled) return throttled;
      const response: PlannerReviewStateResponse = await plannerSaveReviewState(
        context.db,
        {
          userId: context.user.id,
          weekStart: c.req.param("week"),
          state: c.req.valid("json").state,
        },
      );
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// Start over: clears the page's state and both done marks; saved results stay.
plannerGoalsApi.post("/review/:week/start-over", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    const response: PlannerReviewStateResponse = await plannerStartReviewOver(
      context.db,
      { userId: context.user.id, weekStart: c.req.param("week") },
    );
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});

plannerGoalsApi.post(
  "/review/:week/look-back",
  zValidator("json", plannerLookBackSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      plannerAssertToday(body.today, new Date());
      const response: PlannerLookBackResponse = await plannerSaveLookBack(
        context.db,
        {
          user: context.user,
          scope: { userLimits: context.userLimits, userId: context.user.id },
          weekStart: c.req.param("week"),
          body,
        },
      );
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerGoalsApi.post(
  "/review/:week/look-forward",
  zValidator("json", plannerCommitSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      plannerAssertToday(body.today, new Date());
      const response: PlannerCommitResponse = await plannerCommitPlan(
        context.db,
        {
          user: context.user,
          actor: await plannerResolveActor(c, context.credential),
          weekStart: c.req.param("week"),
          body,
        },
      );
      // The plan is in: the review's agent session is done.
      const agent = plannerAgent(c.env);
      if (agent) {
        const ending = endReviewAgent(
          agent,
          context,
          plannerResolveReviewWeek(body.today, c.req.param("week")),
        );
        try {
          c.executionCtx.waitUntil(ending);
        } catch {
          await ending;
        }
      }
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

/** Ends the review's open agent session, if any. Never throws. */
async function endReviewAgent(
  agent: PlannerAgent,
  context: RequestContext,
  weekStart: string,
): Promise<void> {
  try {
    const open = await plannerAgentFindOpenRun(context.db, {
      userId: context.user.id,
      ownerKey: plannerAgentWeekKey(weekStart),
    });
    if (open?.sessionId) {
      await plannerEndAgent(agent, context.db, {
        userId: context.user.id,
        sessionId: open.sessionId,
      });
    }
  } catch (error) {
    plannerLogAgentError("end", error);
  }
}

// --- The review's model and the agent --------------------------------------------

type AiSetup =
  | { response: Response }
  | {
      /** The review's model, or null when it is off. */
      model: PlannerReviewModel | null;
      /** The general agent, or null when this deployment runs without it. */
      agent: PlannerAgent | null;
      review: PlannerReviewContext;
      context: RequestContext;
    };

/**
 * What every AI route does first: authenticate, throttle, check `today` and the
 * week, find the agent and the model and read the review's context. With
 * neither it is a 503 the page answers with its own drafts.
 */
async function aiSetup(
  c: Context<HonoBindings>,
  today: string,
  limited: () => Response,
): Promise<AiSetup> {
  const context = await getRequestContext(c);
  const throttled = await rateLimitGuard(c, "planner-ai", context.user.id);
  if (throttled) return { response: limited() };
  plannerAssertToday(today, new Date());
  const weekStart = plannerResolveReviewWeek(today, c.req.param("week"));
  const model = plannerReviewModel(c.env);
  const agent = plannerAgent(c.env);
  if (!model && !agent) return { response: c.json(AI_UNAVAILABLE, 503) };
  const review = await plannerReadReviewContext(context.db, {
    userId: context.user.id,
    ownerName: context.user.name,
    weekStart,
    today,
    // Workers AI's model has a small context; the others read most weeks
    // whole. The agent reads the week itself, so this is the model's.
    diaryChars:
      model?.provider === "workers-ai"
        ? PLANNER_DIARY_CHARS_SMALL
        : PLANNER_DIARY_CHARS,
  });
  return { model, agent, review, context };
}

const tooMany = (c: Context<HonoBindings>) => () =>
  c.json(
    { error: { message: "Too many requests. Please try again later." } },
    429,
  );

/** The 503 for an agent that could not take the job, with its reason. */
function agentUnavailable(c: Context<HonoBindings>, error: unknown) {
  return error instanceof PlannerAgentUnavailableError
    ? c.json({ error: { message: error.message, code: error.code } }, 503)
    : c.json(AI_UNAVAILABLE, 503);
}

/** The review's answers as the prompts read them. */
function answersOf(body: {
  last_answer: string[];
  answers: string[][];
  goal_results: Array<{
    goal_id: string;
    result: "met" | "partial" | "missed" | null;
  }>;
  coach_notes: string[];
}): PlannerReviewAnswers {
  return {
    lastAnswer: body.last_answer,
    answers: body.answers,
    goalResults: body.goal_results.map((entry) => ({
      goalId: entry.goal_id,
      result: entry.result,
    })),
    coachNotes: body.coach_notes,
  };
}

/** Runs one JSON model call; a failure is a 503 the page falls back from. */
async function completeOr503<T>(
  c: Context<HonoBindings>,
  model: PlannerReviewModel | null,
  task: string,
  messages: PlannerChatMessage[],
  options: {
    maxTokens: number;
    temperature: number;
    effort?: PlannerModelOptions["effort"];
  },
  parse: (raw: string) => T,
): Promise<Response> {
  if (!model) return c.json(AI_UNAVAILABLE, 503);
  let raw: string;
  try {
    raw = await model.complete(messages, {
      ...options,
      signal: c.req.raw.signal,
    });
  } catch (error) {
    plannerLogModelError(model, task, error);
    return c.json(AI_UNAVAILABLE, 503);
  }
  return c.json(parse(raw) as object);
}

/**
 * Gives a step to the review's agent session when the page has one: the
 * session id once it is sent, or null to answer with the review's model
 * instead (no agent, no session, the session is gone, or sending failed).
 */
async function agentStep(
  setup: {
    agent: PlannerAgent | null;
    review: PlannerReviewContext;
    context: RequestContext;
  },
  session: string | undefined,
  step: string,
  message: () => string,
  stepInput?: unknown,
): Promise<string | null> {
  const { agent, review, context } = setup;
  if (!agent || !session) return null;
  try {
    const sent = await plannerSendAgent(agent, context.db, {
      userId: context.user.id,
      ownerKey: plannerAgentWeekKey(review.weekStart),
      sessionId: session,
      step,
      stepInput,
      message: message(),
    });
    return sent === "sent" ? session : null;
  } catch (error) {
    plannerLogAgentError("send", error);
    return null;
  }
}

// The opening starts the review's agent session, or picks up the one the
// Sunday schedule prepared (planner-agent-schedule.ts), whose answer is then
// usually there already. Asked again with the page's session, it starts over.
plannerGoalsApi.post(
  "/review/:week/ai/opening",
  zValidator("json", plannerAiOpeningSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await aiSetup(c, body.today, tooMany(c));
      if ("response" in setup) return setup.response;
      const { agent, model, review, context } = setup;
      if (agent) {
        const owner = {
          userId: context.user.id,
          ownerKey: plannerAgentWeekKey(review.weekStart),
        };
        try {
          if (body.session) {
            await plannerEndAgent(agent, context.db, {
              userId: owner.userId,
              sessionId: body.session,
            });
          }
          const open = await plannerAgentFindOpenRun(context.db, owner);
          if (open?.sessionId && open.step === "opening" && !body.session) {
            return c.json({ agent: open.sessionId });
          }
          if (open?.sessionId) {
            await plannerEndAgent(agent, context.db, {
              userId: owner.userId,
              sessionId: open.sessionId,
            });
          }
          const started = await plannerStartAgent(agent, {
            db: context.db,
            env: c.env,
            user: context.user,
            authUserId: context.authUserId,
            job: "review",
            ownerKey: owner.ownerKey,
            step: "opening",
            message: plannerAgentOpeningMessage(review),
            title: `Weekly review ${plannerWeekCode(review.weekStart)}`,
          });
          return c.json({ agent: started.sessionId });
        } catch (error) {
          // The review's model drafts the opening instead, when there is one.
          plannerLogAgentError("start", error);
          if (!model) return agentUnavailable(c, error);
        }
      }
      return completeOr503(
        c,
        model,
        "opening",
        plannerOpeningMessages(review),
        { maxTokens: 2_000, temperature: 0.4 },
        (raw): PlannerAiOpeningResponse => plannerParseWeekOpening(raw, review),
      );
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerGoalsApi.post(
  "/review/:week/ai/close",
  zValidator("json", plannerAiCloseSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await aiSetup(c, body.today, tooMany(c));
      if ("response" in setup) return setup.response;
      const sent = await agentStep(setup, body.session, "close", () =>
        plannerAgentCloseMessage(setup.review, answersOf(body)),
      );
      if (sent) return c.json({ agent: sent });
      return completeOr503(
        c,
        setup.model,
        "close",
        plannerCloseMessages(setup.review, answersOf(body)),
        { maxTokens: 1_200, temperature: 0.2 },
        (raw): PlannerAiCloseResponse => plannerParseClose(raw),
      );
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

const AGENT_STEPS = [
  "opening",
  "coach",
  "close",
  "memo",
  "propose",
  "check",
] as const;
/** The steps a run can be at once its memo was read. */
const MEMO_DONE_STEPS: readonly string[] = ["propose", "check"];

// The agent's answer to the step it was given, asked for every few seconds.
// Not rate limited: each ask is a status read until the answer is there. Once
// the memo is read the session goes on to the proposals for next week, which
// the page reads from /review/:week/proposals; the plan's commit ends it.
plannerGoalsApi.get("/review/:week/ai/agent/:session", async (c) => {
  try {
    const context = await getRequestContext(c);
    const agent = plannerAgent(c.env);
    if (!agent) return c.json(AI_UNAVAILABLE, 503);
    const today = c.req.query("today") ?? "";
    plannerAssertToday(today, new Date());
    const weekStart = plannerResolveReviewWeek(today, c.req.param("week"));
    const step = AGENT_STEPS.find((name) => name === c.req.query("step"));
    const mode = c.req.query("mode") ?? "free";
    if (!step || (mode !== "free" && mode !== "force" && mode !== "chat")) {
      return c.json({ error: { message: "Unknown step." } }, 400);
    }
    const owner = {
      userId: context.user.id,
      ownerKey: plannerAgentWeekKey(weekStart),
      sessionId: c.req.param("session"),
    };
    let state: PlannerAgentState;
    try {
      state = await plannerPollAgent(agent, context.db, { ...owner, step });
    } catch (error) {
      plannerLogAgentError("poll", error);
      return c.json<PlannerAgentResponse>({ status: "running" });
    }
    if (state.status === "missing") {
      return c.json({ error: { message: "Not found." } }, 404);
    }
    if (state.status === "moved") {
      // Another request read this step and sent the next. A memo asked for
      // again comes back as it was, and the proposals are not asked twice.
      if (step !== "memo" || !MEMO_DONE_STEPS.includes(state.run.step ?? "")) {
        return c.json({ error: { message: "That step is over." } }, 409);
      }
      const again = await plannerReadAgentMemo(agent, owner.sessionId).catch(
        () => null,
      );
      if (!again) return c.json<PlannerAgentResponse>({ status: "running" });
      const filter = plannerMemoStreamFilter();
      const memo = filter.push(again) + filter.finish();
      return c.json<PlannerAgentResponse>({ status: "done", step, memo });
    }
    if (state.status !== "done") return c.json<PlannerAgentResponse>(state);
    const texts = state.texts;
    // A JSON answer is the last reply that holds one; anything said before it
    // (the agent narrating what it reads) is not the answer.
    const json = [...texts].reverse().find((text) => text.includes("{")) ?? "";
    // The receipts are checked against the week whole, read again here.
    const review = () =>
      plannerReadReviewContext(context.db, {
        userId: context.user.id,
        ownerName: context.user.name,
        weekStart,
        today,
        diaryChars: PLANNER_AGENT_DIARY_CHARS,
      });
    if (step === "opening") {
      return c.json<PlannerAgentResponse>({
        status: "done",
        step,
        opening: plannerParseWeekOpening(json, await review()),
      });
    }
    if (step === "close") {
      return c.json<PlannerAgentResponse>({
        status: "done",
        step,
        close: plannerParseClose(json),
      });
    }
    if (step === "coach") {
      const filter = plannerCoachStreamFilter(mode);
      const head = filter.push(texts.at(-1) ?? "");
      const { tail, advance } = filter.finish();
      return c.json<PlannerAgentResponse>({
        status: "done",
        step,
        text: `${head}${tail}`.trim(),
        advance: advance ?? null,
      });
    }
    if (step === "propose") {
      return c.json<PlannerAgentResponse>({ status: "done", step });
    }
    if (step === "check") {
      const input = state.run.stepInput as {
        plan?: PlannerCheckGoal[];
      } | null;
      const plan = Array.isArray(input?.plan) ? input.plan : [];
      return c.json<PlannerAgentResponse>({
        status: "done",
        step,
        check: { flags: plannerParseCheck(json, await review(), plan) },
      });
    }
    let raw: string | null;
    try {
      raw = await plannerReadAgentMemo(agent, owner.sessionId);
    } catch (error) {
      plannerLogAgentError("memo", error);
      return c.json<PlannerAgentResponse>({ status: "running" });
    }
    if (!raw) {
      await plannerEndAgent(agent, context.db, { ...owner, failed: true });
      return c.json<PlannerAgentResponse>({ status: "failed" });
    }
    const filter = plannerMemoStreamFilter();
    const memo = filter.push(raw) + filter.finish();
    // Next week's proposals, made while the owner reads the memo. A new
    // propose step replaces the week's proposals nobody has acted on yet.
    // Only the request that moves the run on asks for them.
    const claimed = await plannerAgentClaimStep(context.db, {
      runId: state.run.id,
      from: "memo",
      to: "propose",
    });
    if (claimed) {
      const week = await review();
      await plannerAgentClearOpenProposals(context.db, {
        userId: owner.userId,
        weekStart: week.planWeek,
      });
      const proposing = await plannerSendAgent(agent, context.db, {
        ...owner,
        step: "propose",
        message: plannerAgentProposeMessage(week),
      }).catch((error: unknown) => {
        plannerLogAgentError("propose", error);
        return "missing" as const;
      });
      if (proposing !== "sent") await plannerEndAgent(agent, context.db, owner);
    }
    return c.json<PlannerAgentResponse>({ status: "done", step, memo });
  } catch (error) {
    return jsonError(c, error);
  }
});

// The agent's proposals for the week being planned, which Look forward shows
// as cards. `pending` while the agent is still proposing; the page asks again
// every few seconds until it is not.
plannerGoalsApi.get(
  "/review/:week/proposals",
  zValidator("query", plannerReviewStatusQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const { today } = c.req.valid("query");
      plannerAssertToday(today, new Date());
      const weekStart = plannerResolveReviewWeek(today, c.req.param("week"));
      const ownerKey = plannerAgentWeekKey(weekStart);
      const agent = plannerAgent(c.env);
      let pending = false;
      const open = agent
        ? await plannerAgentFindOpenRun(db, { userId: user.id, ownerKey })
        : null;
      if (agent && open?.sessionId && open.step === "propose") {
        if (open.stepDoneAt) {
          pending = false;
        } else {
          const state = await plannerPollAgent(agent, db, {
            userId: user.id,
            ownerKey,
            sessionId: open.sessionId,
          }).catch((error: unknown) => {
            plannerLogAgentError("poll", error);
            return { status: "running" } as const;
          });
          pending = state.status === "running";
        }
      }
      const response: PlannerAgentProposalsResponse = {
        proposals: await plannerAgentListProposals(db, {
          userId: user.id,
          weekStart: plannerAddDays(weekStart, 7),
        }),
        pending,
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerGoalsApi.post(
  "/agent/proposals/:id",
  zValidator("json", plannerAgentSettleSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const response: PlannerAgentProposalResponse = {
        proposal: await plannerAgentSettleProposal(context.db, {
          userId: context.user.id,
          id: c.req.param("id"),
          state: c.req.valid("json").state,
        }),
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerGoalsApi.post(
  "/review/:week/ai/check",
  zValidator("json", plannerAiCheckSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await aiSetup(c, body.today, tooMany(c));
      if ("response" in setup) return setup.response;
      const flags = await plannerReadFlags(setup.context.db, {
        userId: setup.context.user.id,
        ids: body.settled.map((entry) => entry.flag_id),
      });
      const byId = new Map(flags.map((flag) => [flag.id, flag]));
      const settled = body.settled.flatMap((entry) => {
        const flag = byId.get(entry.flag_id);
        return flag
          ? [
              {
                label: flag.with_label,
                why: flag.why,
                state: entry.state,
                title: entry.title,
              },
            ]
          : [];
      });
      const plan = body.goals.map((goal) => ({
        id: goal.id,
        pillar: goal.pillar,
        title: goal.title,
        tasks: goal.tasks,
      }));
      // In the review's session the agent checks the plan with everything it
      // read this evening; the poll parses its answer against `plan`.
      const sent = await agentStep(
        setup,
        body.session,
        "check",
        () => plannerAgentCheckMessage(setup.review, plan, settled),
        { plan },
      );
      if (sent) return c.json({ agent: sent });
      return completeOr503(
        c,
        setup.model,
        "check",
        plannerCheckMessages(setup.review, plan, settled),
        // Sonnet 5.5 at medium effort when it is Anthropic's model.
        { maxTokens: 700, temperature: 0.1, effort: "medium" },
        (raw): PlannerAiCheckResponse => ({
          flags: plannerParseCheck(raw, setup.review, plan),
        }),
      );
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

/** A 429 in the streaming routes' own format. */
const tooManyLines = () => () =>
  new Response(`${JSON.stringify({ error: "limited" })}\n`, {
    status: 429,
    headers: NDJSON_HEADERS,
  });

/**
 * Streams lines as NDJSON. When the page stops reading (Stop, or it left), the
 * model call is aborted with it.
 */
function ndjson(
  lines: (signal: AbortSignal) => AsyncGenerator<PlannerAiStreamLine>,
  request: Request,
): Response {
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), {
    once: true,
  });
  const source = lines(abort.signal);
  const encoder = new TextEncoder();
  const write = (line: PlannerAiStreamLine) =>
    encoder.encode(`${JSON.stringify(line)}\n`);
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await source.next();
        if (next.done) controller.close();
        else controller.enqueue(write(next.value));
      } catch {
        controller.enqueue(write({ error: "failed" }));
        controller.close();
      }
    },
    async cancel() {
      abort.abort();
      await source.return(undefined);
    },
  });
  return new Response(body, { headers: NDJSON_HEADERS });
}

plannerGoalsApi.post(
  "/review/:week/ai/coach",
  zValidator("json", plannerAiCoachSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await aiSetup(c, body.today, tooManyLines());
      if ("response" in setup) return setup.response;
      const { model, review } = setup;
      const mode: PlannerCoachMode = body.mode;
      const sent = await agentStep(setup, body.session, "coach", () =>
        plannerAgentCoachMessage(review, mode, body.messages),
      );
      if (sent) {
        return ndjson(async function* () {
          yield { agent: sent };
        }, c.req.raw);
      }
      const messages = plannerCoachMessages(review, mode, body.messages);
      return ndjson(async function* (signal) {
        if (!model) {
          yield { error: "failed" };
          return;
        }
        const filter = plannerCoachStreamFilter(mode);
        try {
          for await (const piece of model.stream(messages, {
            maxTokens: 400,
            temperature: 0.5,
            signal,
          })) {
            const text = filter.push(piece);
            if (text) yield { d: text };
          }
        } catch (error) {
          if (signal.aborted) return;
          plannerLogModelError(model, "coach", error);
          yield { error: "failed" };
          return;
        }
        const { tail, advance } = filter.finish();
        if (tail) yield { d: tail };
        yield { done: true, advance };
      }, c.req.raw);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerGoalsApi.post(
  "/review/:week/ai/memo",
  zValidator("json", plannerAiMemoSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await aiSetup(c, body.today, tooManyLines());
      if ("response" in setup) return setup.response;
      const { agent, model, review, context } = setup;
      const request = {
        ...answersOf(body),
        reviewedOn: body.today,
        scores: body.scores,
        drafted: body.drafted ?? null,
        question: body.question,
        verdict: body.verdict,
        recommended: body.recommended,
        drafts: body.drafts,
      };
      const messages = plannerMemoMessages(review, request);
      return ndjson(async function* (signal) {
        if (agent) {
          try {
            // The review's own session, with the evening's answers added.
            const sent = await agentStep(setup, body.session, "memo", () =>
              plannerAgentMemoMessage(review, request),
            );
            if (sent) {
              yield { agent: sent };
              return;
            }
            // No session to go on with (the opening ran without the agent, or
            // the memo is written again): a session from the memo on.
            const ownerKey = plannerAgentWeekKey(review.weekStart);
            const open = await plannerAgentFindOpenRun(context.db, {
              userId: context.user.id,
              ownerKey,
            });
            if (open?.sessionId) {
              await plannerEndAgent(agent, context.db, {
                userId: context.user.id,
                sessionId: open.sessionId,
              });
            }
            const started = await plannerStartAgent(agent, {
              db: context.db,
              env: c.env,
              user: context.user,
              authUserId: context.authUserId,
              job: "review",
              ownerKey,
              step: "memo",
              message: plannerAgentMemoKickoff(review, request),
              title: `Weekly review ${plannerWeekCode(review.weekStart)}`,
            });
            yield { agent: started.sessionId };
            return;
          } catch (error) {
            plannerLogAgentError("start", error);
            if (!model) {
              yield { error: "failed" };
              return;
            }
          }
        }
        if (!model) {
          yield { error: "failed" };
          return;
        }
        const filter = plannerMemoStreamFilter();
        try {
          for await (const piece of model.stream(messages, {
            maxTokens: 2_600,
            temperature: 0.3,
            signal,
          })) {
            const text = filter.push(piece);
            if (text) yield { d: text };
          }
        } catch (error) {
          if (signal.aborted) return;
          plannerLogModelError(model, "memo", error);
          yield { error: "failed" };
          return;
        }
        const tail = filter.finish();
        if (tail) yield { d: tail };
        yield { done: true };
      }, c.req.raw);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);
