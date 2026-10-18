import {
  type PlannerAgentResponse,
  type PlannerAiCloseResponse,
  type PlannerAiStreamLine,
  type PlannerPeriodAiChecksResponse,
  type PlannerPeriodAiThemesResponse,
  type PlannerPeriodOpeningResponse,
  type PlannerPeriodReviewResponse,
  type PlannerPeriodStateResponse,
  type PlannerPeriodStatusResponse,
  type PlannerSavePeriodResponse,
  plannerAiCloseSchema,
  plannerAiCoachSchema,
  plannerAiMemoSchema,
  plannerAiOpeningSchema,
  plannerPeriodAiChecksSchema,
  plannerPeriodAiCoachSchema,
  plannerPeriodAiMemoSchema,
  plannerPeriodAiThemesSchema,
  plannerPeriodHappenedSchema,
  plannerPeriodLabel,
  plannerPeriodReviewQuerySchema,
  plannerPeriodStatusQuerySchema,
  plannerSavePeriodSchema,
  plannerSavePeriodStateSchema,
} from "@flaremo/contracts";
import {
  PLANNER_AGENT_DIARY_CHARS,
  PLANNER_PERIOD_DIARY_CHARS,
  PLANNER_PERIOD_DIARY_CHARS_SMALL,
  type PlannerChatMessage,
  type PlannerCoachMode,
  type PlannerPeriodContext,
  type PlannerReviewAnswers,
  plannerAgentFindOpenRun,
  plannerAgentPeriodCloseMessage,
  plannerAgentPeriodCoachMessage,
  plannerAgentPeriodMemoKickoff,
  plannerAgentPeriodMemoMessage,
  plannerAgentPeriodOpeningMessage,
  plannerCoachStreamFilter,
  plannerMemoStreamFilter,
  plannerMergePeriodThemes,
  plannerParseClose,
  plannerParsePeriodChecks,
  plannerParsePeriodOpening,
  plannerPeriodAgentKey,
  plannerPeriodChatMemoMessages,
  plannerPeriodChecksMessages,
  plannerPeriodCloseMessages,
  plannerPeriodCoachChatMessages,
  plannerPeriodCoachMessages,
  plannerPeriodMemoMessages,
  plannerPeriodOpeningMessages,
  plannerPeriodStatus,
  plannerPeriodThemesMessages,
  plannerReadPeriodContext,
  plannerReadPeriodReview,
  plannerResolvePeriod,
  plannerSavePeriodReview,
  plannerSavePeriodState,
  plannerStartPeriodOver,
  plannerVerifyQuote,
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
  type PlannerReviewModel,
  plannerLogModelError,
  plannerReviewModel,
} from "./planner-review-ai";
import { plannerAssertToday } from "./planner-route-helpers";

// The month, quarter and year reviews over HTTP (fork-owned add-on,
// docs/planning-cockpit-period-review.md; the routes are listed in
// packages/contracts/src/planner-period-review.ts). planner-api.ts mounts this
// sub-app next to the weekly review's, so it shares the lazy mount, the
// authentication and the JSON 404. Like the weekly review's routes these only
// validate, throttle and serialise; the prompts and parsers are the domain's,
// the model is planner-review-ai.ts's, and the buckets are the same three.

export const plannerPeriodReviewApi = new Hono<HonoBindings>();

type RequestContext = ReturnTypeOfRequestContext;

const NDJSON_HEADERS = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

const AI_UNAVAILABLE = {
  error: {
    message: "The review's model is not available.",
    code: "ai_unavailable",
  },
};

plannerPeriodReviewApi.get(
  "/period-review",
  zValidator("query", plannerPeriodReviewQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const query = c.req.valid("query");
      plannerAssertToday(query.today, new Date());
      const response: PlannerPeriodReviewResponse =
        await plannerReadPeriodReview(db, {
          userId: user.id,
          ownerName: user.name,
          today: query.today,
          level: query.level,
          period: query.period,
          ai:
            plannerReviewModel(c.env) !== null || plannerAgent(c.env) !== null,
        });
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerPeriodReviewApi.get(
  "/period-review/status",
  zValidator("query", plannerPeriodStatusQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const query = c.req.valid("query");
      plannerAssertToday(query.today, new Date());
      const response: PlannerPeriodStatusResponse = await plannerPeriodStatus(
        db,
        { userId: user.id, today: query.today },
      );
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerPeriodReviewApi.patch(
  "/period-review/:level/:period/state",
  zValidator("json", plannerSavePeriodStateSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(
        c,
        "planner-review-state",
        context.user.id,
      );
      if (throttled) return throttled;
      const response: PlannerPeriodStateResponse = await plannerSavePeriodState(
        context.db,
        {
          userId: context.user.id,
          level: c.req.param("level"),
          periodStart: c.req.param("period"),
          state: c.req.valid("json").state,
        },
      );
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerPeriodReviewApi.post(
  "/period-review/:level/:period/start-over",
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const response: PlannerPeriodStateResponse = await plannerStartPeriodOver(
        context.db,
        {
          userId: context.user.id,
          level: c.req.param("level"),
          periodStart: c.req.param("period"),
        },
      );
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerPeriodReviewApi.post(
  "/period-review/:level/:period/save",
  zValidator("json", plannerSavePeriodSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      plannerAssertToday(body.today, new Date());
      const response: PlannerSavePeriodResponse = await plannerSavePeriodReview(
        context.db,
        {
          user: context.user,
          scope: { userLimits: context.userLimits, userId: context.user.id },
          level: c.req.param("level"),
          periodStart: c.req.param("period"),
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
      review: PlannerPeriodContext;
      context: RequestContext;
    };

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
  const { level, periodStart } = plannerResolvePeriod(
    today,
    c.req.param("level"),
    c.req.param("period"),
  );
  const model = plannerReviewModel(c.env);
  if (!model) return { response: c.json(AI_UNAVAILABLE, 503) };
  const review = await plannerReadPeriodContext(context.db, {
    userId: context.user.id,
    ownerName: context.user.name,
    level,
    periodStart,
    today,
    diaryChars:
      diaryChars ??
      (model.provider === "workers-ai"
        ? PLANNER_PERIOD_DIARY_CHARS_SMALL
        : PLANNER_PERIOD_DIARY_CHARS),
  });
  return { model, review, context };
}

const tooMany = (c: Context<HonoBindings>) => () =>
  c.json(
    { error: { message: "Too many requests. Please try again later." } },
    429,
  );

async function completeOr503<T>(
  c: Context<HonoBindings>,
  model: PlannerReviewModel,
  task: string,
  messages: PlannerChatMessage[],
  options: { maxTokens: number; temperature: number },
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

plannerPeriodReviewApi.post(
  "/period-review/:level/:period/ai/checks",
  zValidator("json", plannerPeriodAiChecksSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await aiSetup(c, body.today, tooMany(c));
      if ("response" in setup) return setup.response;
      return completeOr503(
        c,
        setup.model,
        "period-checks",
        plannerPeriodChecksMessages(setup.review),
        { maxTokens: 2_400, temperature: 0.1 },
        (raw): PlannerPeriodAiChecksResponse =>
          plannerParsePeriodChecks(raw, setup.review),
      );
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// Two readers, each with the weeks in its own order, called one after the
// other so neither answer can leak into the other's prompt.
plannerPeriodReviewApi.post(
  "/period-review/:level/:period/ai/themes",
  zValidator("json", plannerPeriodAiThemesSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await aiSetup(c, body.today, tooMany(c));
      if ("response" in setup) return setup.response;
      const options = {
        maxTokens: 1_400,
        temperature: 0.3,
        signal: c.req.raw.signal,
      };
      let first: string;
      let second: string;
      try {
        first = await setup.model.complete(
          plannerPeriodThemesMessages(setup.review, 1),
          options,
        );
        second = await setup.model.complete(
          plannerPeriodThemesMessages(setup.review, 2),
          options,
        );
      } catch (error) {
        plannerLogModelError(setup.model, "period-themes", error);
        return c.json(AI_UNAVAILABLE, 503);
      }
      const response: PlannerPeriodAiThemesResponse = plannerMergePeriodThemes(
        first,
        second,
        setup.review,
      );
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

const tooManyLines = () => () =>
  new Response(`${JSON.stringify({ error: "limited" })}\n`, {
    status: 429,
    headers: NDJSON_HEADERS,
  });

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

plannerPeriodReviewApi.post(
  "/period-review/:level/:period/ai/coach",
  zValidator("json", plannerPeriodAiCoachSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await aiSetup(c, body.today, tooManyLines());
      if ("response" in setup) return setup.response;
      const { model, review } = setup;
      const messages = plannerPeriodCoachMessages(review, {
        step: body.step,
        messages: body.messages,
        answers: body.answers,
      });
      return ndjson(async function* (signal) {
        const filter = plannerCoachStreamFilter("chat");
        try {
          for await (const piece of model.stream(messages, {
            maxTokens: 1_200,
            temperature: 0.4,
            signal,
          })) {
            const text = filter.push(piece);
            if (text) yield { d: text };
          }
        } catch (error) {
          if (!signal.aborted)
            plannerLogModelError(model, "period-coach", error);
          yield { error: "failed" as const };
          return;
        }
        const { tail } = filter.finish();
        if (tail) yield { d: tail };
        yield { done: true as const };
      }, c.req.raw);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerPeriodReviewApi.post(
  "/period-review/:level/:period/ai/memo",
  zValidator("json", plannerPeriodAiMemoSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await aiSetup(c, body.today, tooManyLines());
      if ("response" in setup) return setup.response;
      const { model, review } = setup;
      const messages = plannerPeriodMemoMessages(review, {
        answers: body.answers,
        goalResults: body.goal_results,
        verdict: body.verdict,
        forecast: body.forecast,
      });
      return ndjson(async function* (signal) {
        const filter = plannerMemoStreamFilter();
        try {
          for await (const piece of model.stream(messages, {
            maxTokens: 3_000,
            temperature: 0.3,
            signal,
          })) {
            const text = filter.push(piece);
            if (text) yield { d: text };
          }
        } catch (error) {
          if (!signal.aborted)
            plannerLogModelError(model, "period-memo", error);
          yield { error: "failed" as const };
          return;
        }
        const tail = filter.finish();
        if (tail) yield { d: tail };
        yield { done: true as const };
      }, c.req.raw);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// --- The month and quarter chat ---------------------------------------------------
//
// The weekly review's Look back over a month or a quarter: the same requests
// and answers as /review/:week/ai/* (planner-goals-api.ts), so the page runs
// it with the weekly review's own chat. With the general agent configured, one
// agent session carries the whole review, as it does for a week; its key is
// the period ("month:2026-10-01") in place of the week's Monday.

const CHAT = "/period-review/:level/:period/chat/ai";

type ChatSetup =
  | { response: Response }
  | {
      model: PlannerReviewModel | null;
      agent: PlannerAgent | null;
      review: PlannerPeriodContext;
      context: RequestContext;
    };

/** aiSetup for the chat: the agent or the model will do. */
async function chatSetup(
  c: Context<HonoBindings>,
  today: string,
  limited: () => Response,
): Promise<ChatSetup> {
  const context = await getRequestContext(c);
  const throttled = await rateLimitGuard(c, "planner-ai", context.user.id);
  if (throttled) return { response: limited() };
  plannerAssertToday(today, new Date());
  const { level, periodStart } = plannerResolvePeriod(
    today,
    c.req.param("level"),
    c.req.param("period"),
  );
  const model = plannerReviewModel(c.env);
  const agent = plannerAgent(c.env);
  if (!model && !agent) return { response: c.json(AI_UNAVAILABLE, 503) };
  const review = await plannerReadPeriodContext(context.db, {
    userId: context.user.id,
    ownerName: context.user.name,
    level,
    periodStart,
    today,
    // The agent reads the period itself, so this is the model's.
    diaryChars:
      model?.provider === "workers-ai"
        ? PLANNER_PERIOD_DIARY_CHARS_SMALL
        : PLANNER_PERIOD_DIARY_CHARS,
  });
  return { model, agent, review, context };
}

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

function agentKey(review: PlannerPeriodContext): string {
  return plannerPeriodAgentKey(review.level, review.periodStart);
}

/** Gives a step to the period's agent session; null to use the model instead. */
async function agentStep(
  setup: {
    agent: PlannerAgent | null;
    review: PlannerPeriodContext;
    context: RequestContext;
  },
  session: string | undefined,
  step: string,
  message: () => string,
): Promise<string | null> {
  const { agent, review, context } = setup;
  if (!agent || !session) return null;
  try {
    const sent = await plannerSendAgent(agent, context.db, {
      userId: context.user.id,
      ownerKey: agentKey(review),
      sessionId: session,
      step,
      message: message(),
    });
    return sent === "sent" ? session : null;
  } catch (error) {
    plannerLogAgentError("send", error);
    return null;
  }
}

/** Starts the period's session, ending any other one it has open. */
async function startPeriodAgent(
  c: Context<HonoBindings>,
  agent: PlannerAgent,
  setup: { review: PlannerPeriodContext; context: RequestContext },
  input: { step: string; message: string },
): Promise<string> {
  const { review, context } = setup;
  const ownerKey = agentKey(review);
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
    job: "period",
    ownerKey,
    step: input.step,
    message: input.message,
    title: `${plannerPeriodLabel(review.level, review.periodStart)} review`,
  });
  return started.sessionId;
}

plannerPeriodReviewApi.post(
  `${CHAT}/opening`,
  zValidator("json", plannerAiOpeningSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await chatSetup(c, body.today, tooMany(c));
      if ("response" in setup) return setup.response;
      const { agent, model, review, context } = setup;
      if (agent) {
        try {
          if (body.session) {
            await plannerEndAgent(agent, context.db, {
              userId: context.user.id,
              sessionId: body.session,
            });
          }
          const session = await startPeriodAgent(c, agent, setup, {
            step: "opening",
            message: plannerAgentPeriodOpeningMessage(review),
          });
          return c.json({ agent: session });
        } catch (error) {
          // The review's model drafts the opening instead, when there is one.
          plannerLogAgentError("start", error);
          if (!model) return agentUnavailable(c, error);
        }
      }
      if (!model) return c.json(AI_UNAVAILABLE, 503);
      return completeOr503(
        c,
        model,
        "period-opening",
        plannerPeriodOpeningMessages(review),
        { maxTokens: 2_400, temperature: 0.3 },
        (raw): PlannerPeriodOpeningResponse =>
          plannerParsePeriodOpening(raw, review),
      );
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerPeriodReviewApi.post(
  `${CHAT}/close`,
  zValidator("json", plannerAiCloseSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await chatSetup(c, body.today, tooMany(c));
      if ("response" in setup) return setup.response;
      const sent = await agentStep(setup, body.session, "close", () =>
        plannerAgentPeriodCloseMessage(setup.review, answersOf(body)),
      );
      if (sent) return c.json({ agent: sent });
      if (!setup.model) return c.json(AI_UNAVAILABLE, 503);
      return completeOr503(
        c,
        setup.model,
        "period-close",
        plannerPeriodCloseMessages(setup.review, answersOf(body)),
        { maxTokens: 1_400, temperature: 0.2 },
        (raw): PlannerAiCloseResponse => plannerParseClose(raw),
      );
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerPeriodReviewApi.post(
  `${CHAT}/coach`,
  zValidator("json", plannerAiCoachSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await chatSetup(c, body.today, tooManyLines());
      if ("response" in setup) return setup.response;
      const { model, review } = setup;
      const mode: PlannerCoachMode = body.mode;
      const sent = await agentStep(setup, body.session, "coach", () =>
        plannerAgentPeriodCoachMessage(review, mode, body.messages),
      );
      if (sent) {
        return ndjson(async function* () {
          yield { agent: sent };
        }, c.req.raw);
      }
      const messages = plannerPeriodCoachChatMessages(
        review,
        mode,
        body.messages,
      );
      return ndjson(async function* (signal) {
        if (!model) {
          yield { error: "failed" as const };
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
          plannerLogModelError(model, "period-coach", error);
          yield { error: "failed" as const };
          return;
        }
        const { tail, advance } = filter.finish();
        if (tail) yield { d: tail };
        yield { done: true as const, advance };
      }, c.req.raw);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

/** The memo request: the weekly memo's, plus what happened (already checked). */
const periodChatMemoSchema = plannerAiMemoSchema.extend({
  happened: plannerPeriodHappenedSchema.array().max(16).optional(),
});

plannerPeriodReviewApi.post(
  `${CHAT}/memo`,
  zValidator("json", periodChatMemoSchema),
  async (c) => {
    try {
      const body = c.req.valid("json");
      const setup = await chatSetup(c, body.today, tooManyLines());
      if ("response" in setup) return setup.response;
      const { agent, model, review } = setup;
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
      // Each claim is checked again here: only words found in the rows stay.
      const happened = (body.happened ?? []).filter(
        (entry) => plannerVerifyQuote(entry.quote, review.raw).verified,
      );
      const messages = plannerPeriodChatMemoMessages(review, request, happened);
      return ndjson(async function* (signal) {
        if (agent) {
          try {
            const sent = await agentStep(setup, body.session, "memo", () =>
              plannerAgentPeriodMemoMessage(review, request, happened),
            );
            if (sent) {
              yield { agent: sent };
              return;
            }
            // No session to go on with: a session for the memo alone.
            yield {
              agent: await startPeriodAgent(c, agent, setup, {
                step: "memo",
                message: plannerAgentPeriodMemoKickoff(
                  review,
                  request,
                  happened,
                ),
              }),
            };
            return;
          } catch (error) {
            plannerLogAgentError("start", error);
            if (!model) {
              yield { error: "failed" as const };
              return;
            }
          }
        }
        if (!model) {
          yield { error: "failed" as const };
          return;
        }
        const filter = plannerMemoStreamFilter();
        try {
          for await (const piece of model.stream(messages, {
            maxTokens: 3_200,
            temperature: 0.3,
            signal,
          })) {
            const text = filter.push(piece);
            if (text) yield { d: text };
          }
        } catch (error) {
          if (signal.aborted) return;
          plannerLogModelError(model, "period-memo", error);
          yield { error: "failed" as const };
          return;
        }
        const tail = filter.finish();
        if (tail) yield { d: tail };
        yield { done: true as const };
      }, c.req.raw);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// The agent's answer to a step, asked for every few seconds, as for a week.
// The memo is the last step (the period's memories are proposed in it): once
// it is read, the session is deleted.
plannerPeriodReviewApi.get(`${CHAT}/agent/:session`, async (c) => {
  try {
    const context = await getRequestContext(c);
    const agent = plannerAgent(c.env);
    if (!agent) return c.json(AI_UNAVAILABLE, 503);
    const today = c.req.query("today") ?? "";
    plannerAssertToday(today, new Date());
    const { level, periodStart } = plannerResolvePeriod(
      today,
      c.req.param("level"),
      c.req.param("period"),
    );
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
      ownerKey: plannerPeriodAgentKey(level, periodStart),
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
      return c.json({ error: { message: "That step is over." } }, 409);
    }
    if (state.status !== "done") return c.json<PlannerAgentResponse>(state);
    const texts = state.texts;
    const json = [...texts].reverse().find((text) => text.includes("{")) ?? "";
    if (step === "opening") {
      // The receipts are checked against the period's rows, read again here.
      const review = await plannerReadPeriodContext(context.db, {
        userId: context.user.id,
        ownerName: context.user.name,
        level,
        periodStart,
        today,
        diaryChars: PLANNER_AGENT_DIARY_CHARS,
      });
      return c.json<PlannerAgentResponse>({
        status: "done",
        step,
        opening: plannerParsePeriodOpening(json, review),
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
      raw = await plannerReadAgentMemo(agent, owner.sessionId);
    } catch (error) {
      plannerLogAgentError("memo", error);
      return c.json<PlannerAgentResponse>({ status: "running" });
    }
    await plannerEndAgent(agent, context.db, { ...owner, failed: !raw });
    if (!raw) return c.json<PlannerAgentResponse>({ status: "failed" });
    const filter = plannerMemoStreamFilter();
    const memo = filter.push(raw) + filter.finish();
    return c.json<PlannerAgentResponse>({ status: "done", step, memo });
  } catch (error) {
    return jsonError(c, error);
  }
});
