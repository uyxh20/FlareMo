import {
  type PlannerMorningResponse,
  plannerMorningDirectionFor,
  plannerMorningDismissSchema,
  plannerMorningLineInputSchema,
  plannerMorningQuerySchema,
} from "@flaremo/contracts";
import {
  plannerCleanMorningLine,
  plannerDismissMorning,
  plannerMorningMessages,
  plannerMorningModel,
  plannerReadMorningContext,
  plannerReadMorningDismissed,
  plannerReadMorningLine,
  plannerRecentMorningLines,
  plannerSaveMorningLine,
} from "@flaremo/domain/src/planner";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getRequestContext, type HonoBindings } from "../context";
import type { FlareMoEnv } from "../env";
import { jsonError } from "../http";
import { rateLimitGuard } from "../rate-limit";
import { plannerAssertToday } from "./planner-route-helpers";

// The morning page over HTTP (fork-owned add-on, docs/fork-customizations.md,
// "Morning page"; the routes are listed in
// packages/contracts/src/planner-morning.ts). planner-api.ts mounts this
// sub-app, so it shares that file's lazy mount, authentication and JSON 404.
//
// The line is written by Claude Opus 5.5 at medium effort through the Worker
// secret ANTHROPIC_API_KEY, the key the weekly review already uses. No key, a
// refusal, an empty answer or a failed call all end the same way: no line, and
// the page hides the slot. Nothing is logged but the status and the error
// message: never the prompt, the answer or the key.

export const plannerMorningApi = new Hono<HonoBindings>();

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
/** Room for thinking plus the line itself (the tuning rounds used the same). */
const MAX_TOKENS = 6_000;
const TIMEOUT_MS = 90_000;

function morningKey(env: FlareMoEnv): string | null {
  return env.ANTHROPIC_API_KEY?.trim() || null;
}

async function respond(
  db: Parameters<typeof plannerReadMorningLine>[0],
  env: FlareMoEnv,
  userId: string,
  today: string,
): Promise<PlannerMorningResponse> {
  const [dismissed, line] = await Promise.all([
    plannerReadMorningDismissed(db, { userId, today }),
    plannerReadMorningLine(db, { userId, today }),
  ]);
  return { day: today, dismissed, line, can_write: morningKey(env) !== null };
}

type ModelAnswer = { text: string; inputTokens: number; outputTokens: number };

/** One call to Claude; null on a refusal, an empty answer or any failure. */
async function writeLine(
  apiKey: string,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<ModelAnswer | null> {
  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: plannerMorningModel,
        max_tokens: MAX_TOKENS,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { effort: "medium" },
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      logFailure(`anthropic answered ${response.status}`);
      return null;
    }
    const parsed = (await response.json()) as {
      stop_reason?: string;
      content?: Array<{ type?: string; text?: unknown }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (parsed.stop_reason === "refusal") return null;
    const text = plannerCleanMorningLine(
      (parsed.content ?? [])
        .filter((block) => block.type === "text")
        .map((block) => (typeof block.text === "string" ? block.text : ""))
        .join(""),
    );
    if (!text) return null;
    return {
      text,
      inputTokens: parsed.usage?.input_tokens ?? 0,
      outputTokens: parsed.usage?.output_tokens ?? 0,
    };
  } catch (error) {
    logFailure(error instanceof Error ? error.message : "unknown");
    return null;
  }
}

function logFailure(message: string) {
  console.error(
    JSON.stringify({
      level: "error",
      message: "Morning line model call failed",
      model: plannerMorningModel,
      error: message.slice(0, 300),
    }),
  );
}

plannerMorningApi.get(
  "/morning",
  zValidator("query", plannerMorningQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const { today } = c.req.valid("query");
      plannerAssertToday(today, new Date());
      return c.json(await respond(db, c.env, user.id, today));
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerMorningApi.post(
  "/morning/line",
  zValidator("json", plannerMorningLineInputSchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const { today, replace } = c.req.valid("json");
      plannerAssertToday(today, new Date());
      // A reload (or a second tab) gets the day's line, never a second one.
      if (!replace) {
        const existing = await plannerReadMorningLine(db, {
          userId: user.id,
          today,
        });
        if (existing) return c.json(await respond(db, c.env, user.id, today));
      }
      const apiKey = morningKey(c.env);
      if (!apiKey) return c.json(await respond(db, c.env, user.id, today));
      const throttled = await rateLimitGuard(c, "planner-ai", user.id);
      if (throttled) return throttled;

      const direction = plannerMorningDirectionFor(today);
      const [context, recent] = await Promise.all([
        plannerReadMorningContext(db, { userId: user.id, today }),
        plannerRecentMorningLines(db, { userId: user.id, today }),
      ]);
      const messages = plannerMorningMessages(direction, context, recent);
      const answer = await writeLine(
        apiKey,
        messages.system,
        messages.user,
        c.req.raw.signal,
      );
      if (answer) {
        await plannerSaveMorningLine(db, {
          userId: user.id,
          today,
          text: answer.text,
          direction,
          model: plannerMorningModel,
          inputTokens: answer.inputTokens,
          outputTokens: answer.outputTokens,
        });
      }
      const body = await respond(db, c.env, user.id, today);
      // On a failed "Another" the old line stays on screen.
      return c.json(body);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerMorningApi.post(
  "/morning/dismiss",
  zValidator("json", plannerMorningDismissSchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const { today, line_id } = c.req.valid("json");
      plannerAssertToday(today, new Date());
      await plannerDismissMorning(db, {
        userId: user.id,
        today,
        lineId: line_id ?? null,
      });
      return c.json(await respond(db, c.env, user.id, today));
    } catch (error) {
      return jsonError(c, error);
    }
  },
);
