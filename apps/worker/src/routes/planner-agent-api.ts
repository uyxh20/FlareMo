import {
  type PlannerAgentActionResponse,
  type PlannerAskResponse,
  type PlannerOkResponse,
  plannerAgentSettleActionSchema,
  plannerAskQuerySchema,
  plannerAskSchema,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { NotFoundError, parseResourceName } from "@flaremo/domain";
import {
  plannerAgentAcceptAction,
  plannerAgentAddChat,
  plannerAgentAskKey,
  plannerAgentAskKickoff,
  plannerAgentAskMessage,
  plannerAgentConversationTask,
  plannerAgentFindOpenRun,
  plannerAgentLatestConversation,
  plannerAgentListActions,
  plannerAgentReadChat,
  plannerAgentSettleAction,
  plannerReadTaskDetail,
  plannerSyncHistory,
} from "@flaremo/domain/src/planner";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { getRequestContext, type HonoBindings } from "../context";
import { jsonError } from "../http";
import { rateLimitGuard } from "../rate-limit";
import {
  type PlannerAgent,
  plannerAgent,
  plannerAgentFailure,
  plannerEndAgent,
  plannerLogAgentError,
  plannerPollAgent,
  plannerSendAgent,
  plannerStartAgent,
} from "./planner-agent";
import { plannerAssertToday } from "./planner-route-helpers";

// Ask my diary over HTTP (fork-owned add-on, docs/fork-general-agent.md): the
// bubble's little chat with the general agent, and a task's own chat in the
// task panel (the same conversation bound to a task). A conversation is one
// agent session that can read everything and propose actions (one task field,
// a new task, a new diary entry; migration 9015), which show as cards the owner
// accepts or dismisses here (POST /agent/actions/:id); the accept is the write.
// Each question is a step, and the page asks GET /ask every few seconds until
// the answer is in. The questions and answers are kept in planner_agent_chat,
// so a conversation survives its session: the nightly sweep ends a session put
// down for twelve hours, and the next question starts a new one with the last
// few turns.

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
    return {
      enabled,
      conversation: null,
      task: null,
      messages: [],
      actions: [],
      status: "idle",
    };
  }
  const read = () =>
    plannerAgentReadChat(db, { userId: user.id, conversationId: conversation });
  const task = await plannerAgentConversationTask(db, {
    userId: user.id,
    conversationId: conversation,
  });
  const answer = async (
    messages: Awaited<ReturnType<typeof read>>,
    status: PlannerAskResponse["status"],
  ): Promise<PlannerAskResponse> => ({
    enabled,
    conversation,
    task,
    messages,
    actions: await plannerAgentListActions(db, {
      userId: user.id,
      conversationId: conversation,
    }),
    status,
  });
  const messages = await read();
  const waiting = messages.at(-1)?.role === "owner";
  if (!waiting) return answer(messages, "idle");
  const ownerKey = plannerAgentAskKey(conversation);
  const open = agent
    ? await plannerAgentFindOpenRun(db, { userId: user.id, ownerKey })
    : null;
  if (!agent || !open?.sessionId || open.stepDoneAt) {
    return answer(messages, "failed");
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
    return answer(messages, "running");
  }
  if (state.status === "running") return answer(messages, "running");
  if (state.status === "done") {
    // The answer is the agent's last message; anything before it is the agent
    // saying what it is about to read.
    await plannerAgentAddChat(db, {
      userId: user.id,
      conversationId: conversation,
      role: "agent",
      text: state.texts.at(-1) ?? "",
      runId: open.id,
      taskId: task,
    });
    return answer(await read(), "idle");
  }
  await plannerEndAgent(agent, db, {
    userId: user.id,
    sessionId: open.sessionId,
    failed: true,
  });
  return answer(messages, "failed");
}

/** `tasks/<id>` or a bare id, as every task route takes it. */
const taskIdOf = (value: string) => parseResourceName(value.trim(), "tasks");

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
        (await plannerAgentLatestConversation(
          db,
          user.id,
          query.task ? taskIdOf(query.task) : null,
        ));
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
      // A task's own chat: the task a new conversation names, or the one the
      // conversation was started from. The task must exist to start a chat.
      const taskId = body.conversation
        ? await plannerAgentConversationTask(db, {
            userId: user.id,
            conversationId: conversation,
          })
        : body.task
          ? taskIdOf(body.task)
          : null;
      let task: { id: string; title: string } | null = null;
      if (taskId) {
        const detail = await plannerReadTaskDetail(db, {
          userId: user.id,
          taskId,
        });
        task = { id: detail.task.id, title: detail.task.title };
      }
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
              task,
            }),
            title: task ? "Task chat" : "Ask my diary",
          });
          runId = started.runId;
        }
        await plannerAgentAddChat(db, {
          userId: user.id,
          conversationId: conversation,
          role: "owner",
          text: body.text,
          runId,
          taskId,
        });
      } catch (error) {
        plannerLogAgentError("ask", error);
        return c.json(plannerAgentFailure(error), 503);
      }
      const response: PlannerAskResponse = {
        enabled: true,
        conversation,
        task: taskId,
        messages: await plannerAgentReadChat(db, {
          userId: user.id,
          conversationId: conversation,
        }),
        actions: await plannerAgentListActions(db, {
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

// A proposed action's card: Accept writes it (a task change, a new task or a
// new diary entry, as the app's own routes would), Dismiss puts it away. Both
// are the owner's own clicks, so a cookie session or a PAT may settle one; the
// write itself is made as the proposal ("proposal:<id>" in History).
plannerAgentApi.post(
  "/agent/actions/:id",
  zValidator("json", plannerAgentSettleActionSchema),
  async (c) => {
    try {
      const context = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", context.user.id);
      if (throttled) return throttled;
      const body = c.req.valid("json");
      plannerAssertToday(body.today, new Date());
      const { db, user } = context;
      const id = c.req.param("id");
      const action =
        body.state === "accepted"
          ? await plannerAgentAcceptAction(db, {
              user,
              id,
              today: body.today,
              quota: { userLimits: context.userLimits, userId: user.id },
            })
          : await plannerAgentSettleAction(db, {
              userId: user.id,
              id,
              state: "dismissed",
            });
      if (!action) throw new NotFoundError("Proposal not found.");
      if (body.state === "accepted" && action.kind !== "entry_new") {
        // The accept wrote a task: the archive takes the new line now, past
        // the sync's debounce, so History shows it (with Revert) at once.
        await plannerSyncHistory(db, {
          userId: user.id,
          now: new Date(),
          force: true,
        });
      }
      const response: PlannerAgentActionResponse = { action };
      return c.json(response);
    } catch (error) {
      return jsonError(c, error);
    }
  },
);
