import {
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
} from "@flaremo/contracts";
import {
  PLANNER_DIARY_CHARS,
  PLANNER_DIARY_CHARS_SMALL,
  PLANNER_MEMO_AGENT_DIARY_CHARS,
  type PlannerChatMessage,
  type PlannerCoachMode,
  type PlannerReviewAnswers,
  type PlannerReviewContext,
  plannerAgentCloseMessage,
  plannerAgentCoachMessage,
  plannerAgentOpeningMessage,
  plannerCheckMessages,
  plannerCloseMessages,
  plannerCoachMessages,
  plannerCoachStreamFilter,
  plannerCommitPlan,
  plannerCreateGoal,
  plannerDeleteGoal,
  plannerMemoAgentFiles,
  plannerMemoAgentKickoff,
  plannerMemoAgentStepFiles,
  plannerMemoMessages,
  plannerMemoStreamFilter,
  plannerOpeningMessages,
  plannerParseCheck,
  plannerParseClose,
  plannerParseWeekOpening,
  plannerReadFlags,
  plannerReadGoalsYear,
  plannerReadMemoHistory,
  plannerReadReview,
  plannerReadReviewContext,
  plannerResolveReviewWeek,
  plannerReviewAgentFiles,
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
  type PlannerMemoAgent,
  type PlannerMemoAgentState,
  plannerEndMemoAgent,
  plannerLogAgentError,
  plannerMemoAgent,
  plannerPollMemoAgent,
  plannerReadMemoAgentMemo,
  plannerSendMemoAgent,
  plannerStartMemoAgent,
} from "./planner-memo-agent";
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
        ai: plannerReviewModel(c.env) !== null,
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
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// --- The review's model ---------------------------------------------------------

type AiSetup =
  | { response: Response }
  | {
      model: PlannerReviewModel;
      review: PlannerReviewContext;
      context: RequestContext;
    };

/**
 * What every AI route does first: authenticate, throttle, check `today` and the
 * week, find the model and read the review's context. A missing model is a 503
 * the page answers with its own drafts.
 */
async function aiSetup(
  c: Context<HonoBindings>,
  today: string,
  limited: () => Response,
  diaryChars?: number,
): Promise<AiSetup> {
  const context = await getRequestContext(c);
  const throttled = await rateLimitGuard(c, "planner-ai", context.user.id);
  if (throttled) return { response: limited() };
  plannerAssertToday(today, new Date());
  const weekStart = plannerResolveReviewWeek(today, c.req.param("week"));
  const model = plannerReviewModel(c.env);
  if (!model) return { response: c.json(AI_UNAVAILABLE, 503) };
  const review = await plannerReadReviewContext(context.db, {
    userId: context.user.id,
    ownerName: context.user.name,
    weekStart,
    today,
    // Workers AI's model has a small context; the others read most weeks whole.
    diaryChars:
      diaryChars ??
      (model.provider === "workers-ai"
        ? PLANNER_DIARY_CHARS_SMALL
        : PLANNER_DIARY_CHARS),
  });
  return { model, review, context };
}

const tooMany = (c: Context<HonoBindings>) => () =>
  c.json(
    { error: { message: "Too many requests. Please try again later." } },
    429,
  );

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
  model: PlannerReviewModel,
  task: string,
  messages: PlannerChatMessage[],
  options: {
    maxTokens: number;
    temperature: number;
    effort?: PlannerModelOptions["effort"];
  },
  parse: (raw: string) => T,
): Promise<Response> {
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
 * Gives a step to the review's agent session when the agent runs the review
 * and the page has a session: the session id once it is sent, or null to
 * answer with the review's model instead (no agent, no session, the session is
 * gone, or sending failed).
 */
async function agentStep(
  c: Context<HonoBindings>,
  setup: { review: PlannerReviewContext; context: RequestContext },
  session: string | undefined,
  message: () => string,
  files?: Record<string, string>,
): Promise<string | null> {
  const agent: PlannerMemoAgent | null = plannerMemoAgent(c.env);
  if (!agent || !session) return null;
  try {
    const sent = await plannerSendMemoAgent(agent, {
      userId: setup.context.user.id,
      weekStart: setup.review.weekStart,
      sessionId: session,
      message: message(),
      files,
    });
    return sent === "sent" ? session : null;
  } catch (error) {
    plannerLogAgentError("send", error);
    return null;
  }
}

plannerGoalsApi.post(
  "/review/:week/ai/opening",
  zValidator("json", plannerAiOpeningSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const agent = plannerMemoAgent(c.env);
      const setup = await aiSetup(
        c,
        body.today,
        tooMany(c),
        agent ? PLANNER_MEMO_AGENT_DIARY_CHARS : undefined,
      );
      if ("response" in setup) return setup.response;
      if (agent) {
        const { review, context } = setup;
        const owner = { userId: context.user.id, weekStart: review.weekStart };
        if (body.session) {
          await plannerEndMemoAgent(agent, {
            ...owner,
            sessionId: body.session,
          });
        }
        try {
          const history = await plannerReadMemoHistory(context.db, owner);
          const session = await plannerStartMemoAgent(agent, {
            ...owner,
            files: plannerReviewAgentFiles(review, history),
            kickoff: plannerAgentOpeningMessage(review),
          });
          return c.json({ agent: session });
        } catch (error) {
          // The review's model drafts the opening instead, from its own budget.
          plannerLogAgentError("start", error);
          const whole = await plannerReadReviewContext(context.db, {
            userId: context.user.id,
            ownerName: context.user.name,
            weekStart: review.weekStart,
            today: body.today,
            diaryChars: PLANNER_DIARY_CHARS,
          });
          return completeOr503(
            c,
            setup.model,
            "opening",
            plannerOpeningMessages(whole),
            { maxTokens: 2_000, temperature: 0.4 },
            (raw): PlannerAiOpeningResponse =>
              plannerParseWeekOpening(raw, whole),
          );
        }
      }
      return completeOr503(
        c,
        setup.model,
        "opening",
        plannerOpeningMessages(setup.review),
        { maxTokens: 2_000, temperature: 0.4 },
        (raw): PlannerAiOpeningResponse =>
          plannerParseWeekOpening(raw, setup.review),
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
      const sent = await agentStep(c, setup, body.session, () =>
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

// The review agent's answer to the step it was given, asked for every few
// seconds. Not rate limited: each ask is a status read until the answer is
// there. The memo is the last step: once it is read, the session is deleted.
plannerGoalsApi.get("/review/:week/ai/agent/:session", async (c) => {
  try {
    const context = await getRequestContext(c);
    const agent = plannerMemoAgent(c.env);
    if (!agent) return c.json(AI_UNAVAILABLE, 503);
    const today = c.req.query("today") ?? "";
    plannerAssertToday(today, new Date());
    const weekStart = plannerResolveReviewWeek(today, c.req.param("week"));
    const step = c.req.query("step");
    const mode = c.req.query("mode") ?? "free";
    if (
      (step !== "opening" &&
        step !== "coach" &&
        step !== "close" &&
        step !== "memo") ||
      (mode !== "free" && mode !== "force" && mode !== "chat")
    ) {
      return c.json({ error: { message: "Unknown step." } }, 400);
    }
    const owner = {
      userId: context.user.id,
      weekStart,
      sessionId: c.req.param("session"),
    };
    let state: PlannerMemoAgentState;
    try {
      state = await plannerPollMemoAgent(agent, owner);
    } catch (error) {
      plannerLogAgentError("poll", error);
      return c.json<PlannerAgentResponse>({ status: "running" });
    }
    if (state.status === "missing") {
      return c.json({ error: { message: "Not found." } }, 404);
    }
    if (state.status !== "done") return c.json<PlannerAgentResponse>(state);
    const texts = state.texts;
    // A JSON answer is the last reply that holds one; anything said before it
    // (the agent narrating what it reads) is not the answer.
    const json = [...texts].reverse().find((text) => text.includes("{")) ?? "";
    if (step === "opening") {
      // The receipts are checked against the week as the agent's file showed it.
      const review = await plannerReadReviewContext(context.db, {
        userId: context.user.id,
        ownerName: context.user.name,
        weekStart,
        today,
        diaryChars: PLANNER_MEMO_AGENT_DIARY_CHARS,
      });
      return c.json<PlannerAgentResponse>({
        status: "done",
        step,
        opening: plannerParseWeekOpening(json, review),
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
    let raw: string | null;
    try {
      raw = await plannerReadMemoAgentMemo(agent, owner.sessionId);
    } catch (error) {
      plannerLogAgentError("memo", error);
      return c.json<PlannerAgentResponse>({ status: "running" });
    }
    await plannerEndMemoAgent(agent, owner);
    if (!raw) return c.json<PlannerAgentResponse>({ status: "failed" });
    const filter = plannerMemoStreamFilter();
    const memo = filter.push(raw) + filter.finish();
    return c.json<PlannerAgentResponse>({ status: "done", step, memo });
  } catch (error) {
    return jsonError(c, error);
  }
});

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
      const sent = await agentStep(c, setup, body.session, () =>
        plannerAgentCoachMessage(review, mode, body.messages),
      );
      if (sent) {
        return ndjson(async function* () {
          yield { agent: sent };
        }, c.req.raw);
      }
      const messages = plannerCoachMessages(review, mode, body.messages);
      return ndjson(async function* (signal) {
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
      const agent = plannerMemoAgent(c.env);
      const setup = await aiSetup(
        c,
        body.today,
        tooManyLines(),
        agent ? PLANNER_MEMO_AGENT_DIARY_CHARS : undefined,
      );
      if ("response" in setup) return setup.response;
      const { model, review, context } = setup;
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
      if (agent) {
        return ndjson(async function* () {
          try {
            // The review's own session, with the evening's answers added.
            const sent = await agentStep(
              c,
              setup,
              body.session,
              () => plannerMemoAgentKickoff(review.weekStart),
              plannerMemoAgentStepFiles(review, request),
            );
            if (sent) {
              yield { agent: sent };
              return;
            }
            // No session to go on with (the opening ran without the agent, or
            // the memo is written again): a session for the memo alone.
            const history = await plannerReadMemoHistory(context.db, {
              userId: context.user.id,
              weekStart: review.weekStart,
            });
            const session = await plannerStartMemoAgent(agent, {
              userId: context.user.id,
              weekStart: review.weekStart,
              files: plannerMemoAgentFiles(review, request, history),
              kickoff: plannerMemoAgentKickoff(review.weekStart),
            });
            yield { agent: session };
          } catch (error) {
            plannerLogAgentError("start", error);
            yield { error: "failed" };
          }
        }, c.req.raw);
      }
      const messages = plannerMemoMessages(review, request);
      return ndjson(async function* (signal) {
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
