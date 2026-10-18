import {
  type PlannerAskResponse,
  type PlannerOkResponse,
  plannerAskQuerySchema,
  plannerAskSchema,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import {
  plannerAgentAddChat,
  plannerAgentAskKey,
  plannerAgentAskKickoff,
  plannerAgentAskMessage,
  plannerAgentFindOpenRun,
  plannerAgentLatestConversation,
  plannerAgentReadChat,
} from "@flaremo/domain/src/planner";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getRequestContext, type HonoBindings } from "../context";
import { jsonError } from "../http";
import { rateLimitGuard } from "../rate-limit";
import {
  type PlannerAgent,
  PlannerAgentUnavailableError,
  plannerAgent,
  plannerEndAgent,
  plannerLogAgentError,
  plannerPollAgent,
  plannerSendAgent,
  plannerStartAgent,
} from "./planner-agent";
import { plannerAssertToday } from "./planner-route-helpers";

// Ask my diary over HTTP (fork-owned add-on, docs/fork-general-agent.md): the
// sidebar's little chat with the general agent. A conversation is one agent
// session that can read everything and propose nothing; each question is a
// step, and the page asks GET /ask every few seconds until the answer is in.
// The questions and answers are kept in planner_agent_chat, so a conversation
// survives its session: the nightly sweep ends a session put down for twelve
// hours, and the next question starts a new one with the last few turns.

export const plannerAgentApi = new Hono<HonoBindings>();

const AGENT_UNAVAILABLE = {
  error: { message: "The agent is not available.", code: "ai_unavailable" },
};

/**
 * The conversation as the page shows it. While the last question is open,
 * asks the session once: an answer is saved and returned, a failed run ends.
 */
async function readAsk(
  agent: PlannerAgent | null,
  db: FlareMoDb,
  user: UserRow,
  conversation: string | null,
): Promise<PlannerAskResponse> {
  const enabled = agent !== null;
  if (!conversation) {
    return { enabled, conversation: null, messages: [], status: "idle" };
  }
  const read = () =>
    plannerAgentReadChat(db, { userId: user.id, conversationId: conversation });
  let messages = await read();
  const waiting = messages.at(-1)?.role === "owner";
  if (!waiting) return { enabled, conversation, messages, status: "idle" };
  const ownerKey = plannerAgentAskKey(conversation);
  const open = agent
    ? await plannerAgentFindOpenRun(db, { userId: user.id, ownerKey })
    : null;
  if (!agent || !open?.sessionId || open.stepDoneAt) {
    return { enabled, conversation, messages, status: "failed" };
  }
  let state: Awaited<ReturnType<typeof plannerPollAgent>>;
  try {
    state = await plannerPollAgent(agent, db, {
      userId: user.id,
      ownerKey,
      sessionId: open.sessionId,
    });
  } catch (error) {
    plannerLogAgentError("poll", error);
    return { enabled, conversation, messages, status: "running" };
  }
  if (state.status === "running") {
    return { enabled, conversation, messages, status: "running" };
  }
  if (state.status === "done") {
    // The answer is the agent's last message; anything before it is the agent
    // saying what it is about to read.
    await plannerAgentAddChat(db, {
      userId: user.id,
      conversationId: conversation,
      role: "agent",
      text: state.texts.at(-1) ?? "",
      runId: open.id,
    });
    messages = await read();
    return { enabled, conversation, messages, status: "idle" };
  }
  await plannerEndAgent(agent, db, {
    userId: user.id,
    sessionId: open.sessionId,
    failed: true,
  });
  return { enabled, conversation, messages, status: "failed" };
}

plannerAgentApi.get(
  "/ask",
  zValidator("query", plannerAskQuerySchema),
  async (c) => {
    try {
      const { db, user } = await getRequestContext(c);
      const query = c.req.valid("query");
      plannerAssertToday(query.today, new Date());
      const conversation =
        query.conversation ??
        (await plannerAgentLatestConversation(db, user.id));
      return c.json(await readAsk(plannerAgent(c.env), db, user, conversation));
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

plannerAgentApi.post(
  "/ask",
  zValidator("json", plannerAskSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner-ai", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      plannerAssertToday(body.today, new Date());
      const agent = plannerAgent(c.env);
      if (!agent) return c.json(AGENT_UNAVAILABLE, 503);
      const { db, user } = context;
      const conversation = body.conversation ?? crypto.randomUUID();
      const ownerKey = plannerAgentAskKey(conversation);
      const earlier = body.conversation
        ? await plannerAgentReadChat(db, {
            userId: user.id,
            conversationId: conversation,
          })
        : [];
      if (earlier.at(-1)?.role === "owner") {
        // The last question is still open, or failed: the page asks it again.
        const open = await plannerAgentFindOpenRun(db, {
          userId: user.id,
          ownerKey,
        });
        if (open?.sessionId && !open.stepDoneAt) {
          return c.json(
            { error: { message: "Wait for the answer to the last question." } },
            409,
          );
        }
      }
      try {
        const open = await plannerAgentFindOpenRun(db, {
          userId: user.id,
          ownerKey,
        });
        let runId: string | null = open?.id ?? null;
        const sent = open?.sessionId
          ? await plannerSendAgent(agent, db, {
              userId: user.id,
              ownerKey,
              sessionId: open.sessionId,
              step: "ask",
              message: plannerAgentAskMessage({
                ownerName: user.name,
                today: body.today,
                question: body.text,
              }),
            })
          : "missing";
        if (sent === "missing") {
          if (open?.sessionId) {
            await plannerEndAgent(agent, db, {
              userId: user.id,
              sessionId: open.sessionId,
            });
          }
          const started = await plannerStartAgent(agent, {
            db,
            env: c.env,
            user,
            authUserId: context.authUserId,
            job: "ask",
            ownerKey,
            step: "ask",
            message: plannerAgentAskKickoff({
              ownerName: user.name,
              today: body.today,
              question: body.text,
              earlier,
            }),
            title: "Ask my diary",
          });
          runId = started.runId;
        }
        await plannerAgentAddChat(db, {
          userId: user.id,
          conversationId: conversation,
          role: "owner",
          text: body.text,
          runId,
        });
      } catch (error) {
        plannerLogAgentError("ask", error);
        return error instanceof PlannerAgentUnavailableError
          ? c.json({ error: { message: error.message, code: error.code } }, 503)
          : c.json(AGENT_UNAVAILABLE, 503);
      }
      const response: PlannerAskResponse = {
        enabled: true,
        conversation,
        messages: await plannerAgentReadChat(db, {
          userId: user.id,
          conversationId: conversation,
        }),
        status: "running",
      };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);

// A new conversation: the page puts the old one down, and its session ends.
plannerAgentApi.post("/ask/:conversation/end", async (c) => {
  try {
    const context = await getRequestContext(c);
    const throttled = await rateLimitGuard(c, "planner", context.user.id);
    if (throttled) return throttled;
    const agent = plannerAgent(c.env);
    const open = await plannerAgentFindOpenRun(context.db, {
      userId: context.user.id,
      ownerKey: plannerAgentAskKey(c.req.param("conversation")),
    });
    if (agent && open?.sessionId) {
      await plannerEndAgent(agent, context.db, {
        userId: context.user.id,
        sessionId: open.sessionId,
      });
    }
    const response: PlannerOkResponse = { ok: true };
    return c.json(response);
  } catch (error) {
    return jsonError(c, error);
  }
});
