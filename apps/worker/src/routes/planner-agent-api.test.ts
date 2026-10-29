import { applyPlannerMigrations } from "@flaremo/db/src/planner-migrations";
import type { Miniflare } from "miniflare";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getFlareMoDb } from "../context";
import type { FlareMoEnv } from "../env";
import { createTestRuntime, fetchWorker } from "../test-support/runtime";
import { bootstrapAndSignIn } from "../test-support/sign-in";
import { plannerAgent, plannerSweepAgentRuns } from "./planner-agent";
import { plannerAgentSundayPrep } from "./planner-agent-schedule";

// HTTP tests for Ask my diary (planner-agent-api.ts), the Sunday prep
// (planner-agent-schedule.ts) and the nightly sweep (planner-agent.ts). Real
// Worker entry, real auth; Anthropic's API is a stubbed fetch that keeps its
// sessions in memory: nothing leaves the test.

const ORIGIN = "http://flaremo.test";
const API = "/api/app/planner";
const utcDay = () => new Date().toISOString().slice(0, 10);

type FakeSession = {
  body: Record<string, unknown>;
  events: Array<Record<string, unknown>>;
};

/** Anthropic's API as far as the agent's client uses it. */
function fakeAnthropic(answer: (message: string) => string[]) {
  const realFetch = globalThis.fetch;
  const sessions = new Map<string, FakeSession>();
  const sent: Array<{ method: string; path: string }> = [];
  const credentials: Array<Record<string, unknown>> = [];
  let clock = Date.now();
  const at = () => {
    clock = Math.max(clock + 1000, Date.now());
    return new Date(clock).toISOString();
  };
  const reply = (session: FakeSession, message: string) => {
    session.events.push({
      type: "user.message",
      processed_at: at(),
      content: [{ type: "text", text: message }],
    });
    for (const text of answer(message)) {
      session.events.push({
        type: "agent.message",
        processed_at: at(),
        content: [{ type: "text", text }],
      });
    }
    session.events.push({ type: "session.status_idle", processed_at: at() });
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.anthropic.com/")) {
      return realFetch(input, init);
    }
    const method = init?.method ?? "GET";
    const payload =
      typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const path = url.split("/v1")[1] ?? "";
    sent.push({ method, path });
    if (path.startsWith("/vaults/vlt_test/credentials")) {
      if (method === "GET") return Response.json({ data: credentials });
      if (!path.endsWith("/archive")) {
        credentials.push({
          id: `vcrd_${credentials.length + 1}`,
          auth: { mcp_server_url: payload.auth.mcp_server_url },
        });
      }
      return Response.json({});
    }
    if (method === "POST" && path === "/sessions") {
      const id = `sesn_${sessions.size + 1}`;
      const session = { body: payload, events: [] };
      sessions.set(id, session);
      reply(session, payload.initial_events[0].content[0].text);
      return Response.json({ id });
    }
    const [, , id, rest] = path.split(/[/?]/);
    const session = id ? sessions.get(id) : undefined;
    if (!session) return Response.json({ data: [] }, { status: 404 });
    if (method === "DELETE") {
      sessions.delete(id ?? "");
      return Response.json({});
    }
    if (rest === "events" && method === "POST") {
      reply(session, payload.events[0].content[0].text);
      return Response.json({});
    }
    if (rest === "events") {
      return Response.json({ data: session.events, next_page: null });
    }
    return Response.json({
      status: "idle",
      updated_at: "2026-01-01T00:00:00Z",
      metadata: session.body.metadata,
      usage: { list_cost: { amount: "12", currency: "USD" } },
    });
  });
  return { sessions, sent, credentials };
}

describe("the general agent's Ask chat and schedule", () => {
  let runtime: Miniflare;
  let d1: D1Database;
  let env: Env;
  let cookie: string;
  let TODAY: string;

  beforeAll(async () => {
    const created = await createTestRuntime({
      name: "flaremo-planner-agent-api",
      env: { FLAREMO_EMBEDDING_PROVIDER: "none" },
    });
    runtime = created.runtime;
    d1 = created.db;
    env = { ...created.env, AI: undefined } as unknown as Env;
    await applyPlannerMigrations(d1);
    cookie = await bootstrapAndSignIn(env);
  });

  afterAll(async () => {
    await runtime.dispose();
  });

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await d1.batch(
      [
        "planner_agent_chat",
        "planner_agent_proposal",
        "planner_agent_action",
        "planner_agent_run",
        "planner_task_event",
        "planner_task_plan",
        "task_activity",
        "tasks",
      ].map((table) => d1.prepare(`DELETE FROM ${table}`)),
    );
    TODAY = utcDay();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const withEnv = (extra: Record<string, unknown> = {}) =>
    ({
      ...env,
      ANTHROPIC_API_KEY: "test-anthropic-key",
      FLAREMO_AGENT: "agent_test",
      FLAREMO_AGENT_ENVIRONMENT: "env_test",
      FLAREMO_AGENT_STORE: "memstore_test",
      FLAREMO_AGENT_VAULT: "vlt_test",
      ...extra,
    }) as unknown as Env;

  const call = (method: string, path: string, body?: unknown, on = env) =>
    fetchWorker(
      new Request(`${ORIGIN}${API}${path}`, {
        method,
        headers: {
          cookie,
          origin: ORIGIN,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      on,
    );

  async function body<T>(
    response: Response | Promise<Response>,
    status = 200,
  ): Promise<T> {
    const res = await response;
    const text = await res.text();
    expect(res.status, text).toBe(status);
    return JSON.parse(text) as T;
  }

  type Ask = {
    enabled: boolean;
    conversation: string | null;
    messages: Array<{ role: string; text: string }>;
    status: string;
  };

  it("answers in a chat that outlives its session, and proposes nothing", async () => {
    expect(await body<Ask>(call("GET", `/ask?today=${TODAY}`))).toEqual({
      enabled: false,
      conversation: null,
      task: null,
      messages: [],
      actions: [],
      status: "idle",
    });
    await body(
      call("POST", "/ask", { today: TODAY, text: "When did I last run?" }),
      503,
    );

    const api = fakeAnthropic((message) => [
      "Let me look at the entries.",
      `Answer to: ${message.split("\n").filter(Boolean).at(-1)}`,
    ]);
    const agentEnv = withEnv();
    const asked = await body<Ask>(
      call(
        "POST",
        "/ask",
        { today: TODAY, text: "When did I last run?" },
        agentEnv,
      ),
    );
    expect(asked).toMatchObject({
      enabled: true,
      status: "running",
      messages: [{ role: "owner", text: "When did I last run?" }],
    });
    const conversation = asked.conversation ?? "";
    const [first] = [...api.sessions.values()];
    // An Ask session reads its notes but cannot change them, or propose.
    expect(first?.body).toMatchObject({
      title: "Ask my diary",
      resources: [{ type: "memory_store", access: "read_only" }],
      agent: { type: "agent_with_overrides", id: "agent_test" },
    });
    const tools =
      (first?.body.agent as { tools?: Array<Record<string, unknown>> })
        ?.tools ?? [];
    expect(tools.find((tool) => tool.type === "mcp_toolset")).toMatchObject({
      configs: [
        { name: "propose_memory", enabled: false },
        { name: "propose_goal", enabled: false },
        { name: "propose_task", enabled: false },
      ],
    });

    // The page asks until the answer is in: the agent's last message.
    const read = () =>
      body<Ask>(
        call(
          "GET",
          `/ask?today=${TODAY}&conversation=${conversation}`,
          undefined,
          agentEnv,
        ),
      );
    expect(await read()).toMatchObject({
      status: "idle",
      messages: [
        { role: "owner" },
        { role: "agent", text: "Answer to: When did I last run?" },
      ],
    });

    // A follow-up goes to the same session.
    await body(
      call(
        "POST",
        "/ask",
        { today: TODAY, conversation, text: "And before that?" },
        agentEnv,
      ),
    );
    expect((await read()).messages.map((message) => message.text)).toEqual([
      "When did I last run?",
      "Answer to: When did I last run?",
      "And before that?",
      "Answer to: And before that?",
    ]);
    expect(api.sessions.size).toBe(1);

    // Put down, the session ends; the next question starts one with the chat so far.
    await body(call("POST", `/ask/${conversation}/end`, {}, agentEnv));
    expect(api.sessions.size).toBe(0);
    await body(
      call(
        "POST",
        "/ask",
        { today: TODAY, conversation, text: "Why then?" },
        agentEnv,
      ),
    );
    const [second] = [...api.sessions.values()];
    const kickoff = (
      second?.body.initial_events as
        | Array<{ content: Array<{ text: string }> }>
        | undefined
    )?.[0]?.content[0]?.text;
    expect(kickoff).toContain("The conversation so far");
    expect(kickoff).toContain("And before that?");
    // Without a conversation, the latest one is shown.
    expect(
      (await body<Ask>(call("GET", `/ask?today=${TODAY}`, undefined, agentEnv)))
        .conversation,
    ).toBe(conversation);

    for (const logged of vi.mocked(console.error).mock.calls) {
      expect(JSON.stringify(logged)).not.toContain("test-anthropic-key");
      expect(JSON.stringify(logged)).not.toContain("When did I last run");
    }
  });

  it("holds a task's own chat, writes an accepted proposal, and puts it back on revert", async () => {
    const api = fakeAnthropic(() => [
      "I proposed notes; accept them if they fit.",
    ]);
    const agentEnv = withEnv();
    const created = await body<{ task: { id: string } }>(
      call("POST", "/tasks", { title: "Write the guide", today: TODAY }),
      201,
    );
    const taskId = created.task.id;
    const bare = taskId.replace(/^tasks\//, "");

    // A chat started from the task names it, and its session knows the task.
    const asked = await body<Ask & { task: string | null }>(
      call(
        "POST",
        "/ask",
        { today: TODAY, task: taskId, text: "Draft notes for this." },
        agentEnv,
      ),
    );
    expect(asked.task).toBe(taskId);
    const conversation = asked.conversation ?? "";
    const [session] = [...api.sessions.values()];
    expect(session?.body.title).toBe("Task chat");
    const kickoff = (
      session?.body.initial_events as
        | Array<{ content: Array<{ text: string }> }>
        | undefined
    )?.[0]?.content[0]?.text;
    expect(kickoff).toContain("This chat is about one task");
    expect(kickoff).toContain("Write the guide");
    // The task's side lists the task chat; the global Ask window does not.
    const read = (query = "") =>
      body<
        Ask & { task: string | null; actions: Array<Record<string, unknown>> }
      >(call("GET", `/ask?today=${TODAY}${query}`, undefined, agentEnv));
    expect((await read(`&task=${taskId}`)).conversation).toBe(conversation);
    expect((await read()).conversation).toBeNull();

    // The agent's proposal, as its propose_task_change tool files it.
    const actionId = crypto.randomUUID();
    await d1
      .prepare(
        `INSERT INTO planner_agent_action
           (id, user_id, run_id, conversation_id, kind, task_id, field, change, why, state, created_at)
         VALUES (?, ?, NULL, ?, 'task_change', ?, 'notes', ?, 'Asked for notes.', 'open', ?)`,
      )
      .bind(
        actionId,
        (
          await d1
            .prepare("SELECT user_id FROM planner_agent_chat LIMIT 1")
            .first<{ user_id: string }>()
        )?.user_id ?? "",
        conversation,
        taskId,
        JSON.stringify({ notes: "Four parts, one page each." }),
        new Date().toISOString(),
      )
      .run();
    expect((await read(`&conversation=${conversation}`)).actions).toMatchObject(
      [{ id: actionId, kind: "task_change", field: "notes", state: "open" }],
    );

    // The accept is the write; a second accept finds it settled.
    const { action: accepted } = await body<{
      action: { state: string; landed_id: string | null };
    }>(
      call(
        "POST",
        `/agent/actions/${actionId}`,
        { state: "accepted", today: TODAY },
        agentEnv,
      ),
    );
    expect(accepted).toMatchObject({ state: "accepted", landed_id: taskId });
    await body(
      call(
        "POST",
        `/agent/actions/${actionId}`,
        { state: "accepted", today: TODAY },
        agentEnv,
      ),
      400,
    );
    const detail = await body<{ task: { notes: string | null } }>(
      call("GET", `/tasks/${bare}`),
    );
    expect(detail.task.notes).toBe("Four parts, one page each.");

    // History names the proposal; its revert puts the notes back and marks
    // the proposal reverted.
    const history = await body<{
      events: Array<{ id: number; type: string; actor_name: string | null }>;
    }>(call("GET", `/tasks/${bare}/history`));
    const edit = history.events.find((event) => event.type === "updated");
    expect(edit?.actor_name).toBe(`proposal:${actionId}`);
    const back = await body<{
      task: { notes: string | null };
      reverted: { id: number };
    }>(
      call("POST", `/tasks/${bare}/history/${edit?.id}/revert`, {
        today: TODAY,
      }),
    );
    expect(back.task.notes).toBeNull();
    expect(back.reverted.id).toBe(edit?.id);
    expect((await read(`&conversation=${conversation}`)).actions).toMatchObject(
      [{ id: actionId, state: "reverted" }],
    );
    await body(
      call("POST", `/tasks/${bare}/history/${edit?.id}/revert`, {
        today: TODAY,
      }),
    );
    expect(
      (
        await body<{ events: Array<{ type: string }> }>(
          call("GET", `/tasks/${bare}/history`),
        )
      ).events.filter((event) => event.type === "reverted"),
    ).toHaveLength(2);
    await body(
      call("POST", `/tasks/${bare}/history/999999/revert`, { today: TODAY }),
      404,
    );
    await body(
      call(
        "POST",
        `/agent/actions/${crypto.randomUUID()}`,
        {
          state: "dismissed",
          today: TODAY,
        },
        agentEnv,
      ),
      404,
    );
  });

  it("stops at the month's cap", async () => {
    const api = fakeAnthropic(() => ["x"]);
    const capped = await body<{ error: { code: string } }>(
      call(
        "POST",
        "/ask",
        { today: TODAY, text: "Anything?" },
        withEnv({ FLAREMO_AGENT_MONTH_USD: "0.4" }),
      ),
      503,
    );
    expect(capped.error.code).toBe("agent_month_cap");
    expect(api.sessions.size).toBe(0);
    const { results } = await d1
      .prepare("SELECT COUNT(*) AS n FROM planner_agent_chat")
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
  });

  it("says so when Anthropic refuses the agent's key", async () => {
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.anthropic.com/")) {
        return realFetch(input, init);
      }
      return Response.json(
        { type: "error", error: { type: "permission_error" } },
        { status: 403 },
      );
    });
    const refused = await body<{ error: { code: string; message: string } }>(
      call("POST", "/ask", { today: TODAY, text: "Anything?" }, withEnv({})),
      503,
    );
    expect(refused.error).toEqual({
      code: "agent_key_refused",
      message: "The agent is not available: Anthropic refused its API key.",
    });
  });

  it("prepares the Sunday review at noon in Copenhagen, once, and sweeps it", async () => {
    const api = fakeAnthropic(() => ['{"recap": "Ready."}']);
    const agentEnv = withEnv() as unknown as FlareMoEnv;
    // Sunday 18 October 2026: 11:00 UTC is 13:00 in Copenhagen, 10:00 is noon.
    expect(
      await plannerAgentSundayPrep(
        env as unknown as FlareMoEnv,
        Date.parse("2026-10-18T10:00:00Z"),
      ),
    ).toBe("no agent");
    expect(
      await plannerAgentSundayPrep(
        agentEnv,
        Date.parse("2026-10-18T11:00:00Z"),
      ),
    ).toBe("not noon");
    expect(
      await plannerAgentSundayPrep(
        agentEnv,
        Date.parse("2026-10-18T10:00:00Z"),
      ),
    ).toBe("prepared");
    expect(
      await plannerAgentSundayPrep(
        agentEnv,
        Date.parse("2026-10-18T10:00:00Z"),
      ),
    ).toBe("open already");
    expect(api.sessions.size).toBe(1);
    const [session] = [...api.sessions.values()];
    expect(session?.body.metadata).toMatchObject({ key: "week:2026-10-12" });
    const { results } = await d1
      .prepare("SELECT started_by, step, job FROM planner_agent_run")
      .all();
    expect(results).toEqual([
      { started_by: "schedule", step: "opening", job: "review" },
    ]);

    // Twelve hours untouched, the nightly sweep ends it.
    const db = getFlareMoDb(agentEnv);
    const agent = plannerAgent(agentEnv);
    expect(await plannerSweepAgentRuns(agent, db, new Date())).toBe(0);
    expect(
      await plannerSweepAgentRuns(
        agent,
        db,
        new Date(Date.now() + 13 * 3_600_000),
      ),
    ).toBe(1);
    expect(api.sessions.size).toBe(0);
    const ended = await d1
      .prepare("SELECT state, cost_cents FROM planner_agent_run")
      .all();
    expect(ended.results).toEqual([{ state: "ended", cost_cents: 12 }]);
  });
});
