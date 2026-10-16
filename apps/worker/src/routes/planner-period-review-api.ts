import {
  type PlannerAiStreamLine,
  type PlannerPeriodAiChecksResponse,
  type PlannerPeriodAiThemesResponse,
  type PlannerPeriodReviewResponse,
  type PlannerPeriodStateResponse,
  type PlannerPeriodStatusResponse,
  type PlannerSavePeriodResponse,
  plannerPeriodAiChecksSchema,
  plannerPeriodAiCoachSchema,
  plannerPeriodAiMemoSchema,
  plannerPeriodAiThemesSchema,
  plannerPeriodReviewQuerySchema,
  plannerPeriodStatusQuerySchema,
  plannerSavePeriodSchema,
  plannerSavePeriodStateSchema,
} from "@flaremo/contracts";
import {
  PLANNER_PERIOD_DIARY_CHARS,
  PLANNER_PERIOD_DIARY_CHARS_SMALL,
  type PlannerChatMessage,
  type PlannerPeriodContext,
  plannerCoachStreamFilter,
  plannerMemoStreamFilter,
  plannerMergePeriodThemes,
  plannerParsePeriodChecks,
  plannerPeriodChecksMessages,
  plannerPeriodCoachMessages,
  plannerPeriodMemoMessages,
  plannerPeriodStatus,
  plannerPeriodThemesMessages,
  plannerReadPeriodContext,
  plannerReadPeriodReview,
  plannerResolvePeriod,
  plannerSavePeriodReview,
  plannerSavePeriodState,
  plannerStartPeriodOver,
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
          ai: plannerReviewModel(c.env) !== null,
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
      model.provider === "workers-ai"
        ? PLANNER_PERIOD_DIARY_CHARS_SMALL
        : PLANNER_PERIOD_DIARY_CHARS,
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
