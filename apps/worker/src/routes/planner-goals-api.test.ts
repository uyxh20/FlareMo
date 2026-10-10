import {
  plannerAddDays,
  plannerAiCheckResponseSchema,
  plannerAiOpeningResponseSchema,
  plannerBoardResponseSchema,
  plannerCommitResponseSchema,
  plannerGoalResponseSchema,
  plannerGoalsYearResponseSchema,
  plannerLookBackResponseSchema,
  plannerOkResponseSchema,
  plannerReviewResponseSchema,
  plannerReviewStateResponseSchema,
  plannerReviewStatusResponseSchema,
  plannerReviewWeekFor,
  plannerWeekResponseSchema,
  plannerWeekStartOf,
} from "@flaremo/contracts";
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
import type { z } from "zod";
import { createAppTestHarness } from "../test-support/app";
import { createTestRuntime, fetchWorker } from "../test-support/runtime";
import { bootstrapAndSignIn } from "../test-support/sign-in";

// HTTP tests for goals, week records and the weekly review (fork-owned add-on,
// docs/planning-cockpit-goals-review.md; planner-goals-api.ts). Real Worker entry,
// real auth, the planner migrations on top of upstream's. The model is a fake
// Workers AI binding, or a stubbed fetch for Anthropic: nothing leaves the test.
//
// "Today" is the real UTC date (the server only accepts a client date within a
// day of its clock), so every week below is derived from it.

const ORIGIN = "http://flaremo.test";
const API = "/api/app/planner";

const RESET_TABLES = [
  "planner_task_event",
  "planner_task_plan",
  "planner_task_seen",
  "planner_sync_state",
  "planner_goal",
  "planner_week",
  "planner_review",
  "planner_goal_flag",
  "task_activity",
  "tasks",
  "memo_tags",
  "memo_revisions",
  "memos",
] as const;

const utcDay = () => new Date().toISOString().slice(0, 10);

type FakeAiCall = { model: string; inputs: Record<string, unknown> };

/**
 * A stand-in for the Workers AI binding: a whole answer, or the pieces of a
 * streamed one as server-sent events, or a failure.
 */
function fakeAi(options: {
  answer?: string;
  pieces?: string[];
  fail?: boolean;
  calls?: FakeAiCall[];
}) {
  return {
    async run(model: string, inputs: Record<string, unknown>) {
      options.calls?.push({ model, inputs });
      if (options.fail) throw new Error("model down");
      if (inputs.stream) {
        const encoder = new TextEncoder();
        return new ReadableStream<Uint8Array>({
          start(controller) {
            for (const piece of options.pieces ?? []) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ response: piece })}\n\n`,
                ),
              );
            }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        });
      }
      return { response: options.answer ?? "" };
    },
  };
}

/** The lines of an NDJSON body. */
async function lines(
  response: Response,
): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const said = (all: Array<Record<string, unknown>>) =>
  all
    .filter((line) => typeof line.d === "string")
    .map((line) => line.d)
    .join("");

describe("planner goals and weekly review API", () => {
  let runtime: Miniflare;
  let d1: D1Database;
  let env: Env;
  let cookie: string;
  let TODAY: string;
  let REVIEW_WEEK: string;
  let PLAN_WEEK: string;

  const harness = createAppTestHarness(() => ({ env, sessionCookie: cookie }));

  beforeAll(async () => {
    const created = await createTestRuntime({
      name: "flaremo-planner-goals-api",
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
      RESET_TABLES.map((table) => d1.prepare(`DELETE FROM ${table}`)),
    );
    TODAY = utcDay();
    REVIEW_WEEK = plannerReviewWeekFor(TODAY);
    PLAN_WEEK = plannerAddDays(REVIEW_WEEK, 7);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The owner's cookie session, with FlareMo's Origin. */
  const call = (
    method: string,
    path: string,
    body?: unknown,
    options: { env?: Env; headers?: Record<string, string> } = {},
  ) =>
    fetchWorker(
      new Request(`${ORIGIN}${API}${path}`, {
        method,
        headers: {
          ...(options.headers ?? { cookie, origin: ORIGIN }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      options.env ?? env,
    );

  const withEnv = (extra: Record<string, unknown>) =>
    ({ ...env, ...extra }) as unknown as Env;

  async function body<T>(
    response: Response | Promise<Response>,
    status = 200,
  ): Promise<T> {
    const res = await response;
    const text = await res.text();
    expect(res.status, text).toBe(status);
    return JSON.parse(text) as T;
  }

  /** Parses with the contract and checks nothing was lost or added. */
  function onTheWire<T extends z.ZodType>(
    schema: T,
    value: unknown,
  ): z.infer<T> {
    const parsed = schema.parse(value);
    expect(parsed).toEqual(value);
    return parsed;
  }

  const ANSWERS = {
    last_answer: ["Partly"],
    answers: [["Met Acme"], [], [], [], [], [], []],
    goal_results: [],
    coach_notes: [],
  };

  it("creates, edits, lists and removes goals", async () => {
    const year = Number(TODAY.slice(0, 4));
    const created = onTheWire(
      plannerGoalResponseSchema,
      await body(
        call("POST", "/goals", {
          level: "year",
          period_start: TODAY,
          pillar: "work",
          title: "Stay on better terms",
          lines: [{ text: "Grade A title" }],
          status: "contested",
          note: "A later note says otherwise",
        }),
        201,
      ),
    ).goal;
    expect(created.period_start).toBe(`${year}-01-01`);

    const edited = onTheWire(
      plannerGoalResponseSchema,
      await body(
        call("PATCH", `/goals/${created.id}`, { status: "active", note: null }),
      ),
    ).goal;
    expect(edited).toMatchObject({ status: "active", note: null });

    const listed = onTheWire(
      plannerGoalsYearResponseSchema,
      await body(call("GET", `/goals?year=${year}&today=${TODAY}`)),
    );
    expect(listed.goals.map((goal) => goal.id)).toEqual([created.id]);
    expect(listed.current_week).toBe(plannerWeekStartOf(TODAY));

    await body(
      call("POST", "/goals", {
        level: "year",
        period_start: TODAY,
        title: "x",
        extra: true,
      }),
      400,
    );
    await body(
      call("POST", "/goals", { level: "quarter", title: "No period" }),
      400,
    );

    onTheWire(
      plannerOkResponseSchema,
      await body(call("DELETE", `/goals/${created.id}`)),
    );
    const after = await body<{ goals: unknown[] }>(
      call("GET", `/goals?year=${year}&today=${TODAY}`),
    );
    expect(after.goals).toEqual([]);
    await body(call("PATCH", `/goals/${created.id}`, { title: "Gone" }), 404);
  });

  it("records a week's scores in half steps", async () => {
    const week = onTheWire(
      plannerWeekResponseSchema,
      await body(call("PATCH", `/weeks/${REVIEW_WEEK}`, { auth: 4, ach: 3.5 })),
    ).week;
    expect(week).toMatchObject({ auth: 4, ach: 3.5, source: "review" });
    await body(call("PATCH", `/weeks/${REVIEW_WEEK}`, { auth: 4.2 }), 400);
    await body(
      call("PATCH", `/weeks/${plannerAddDays(REVIEW_WEEK, 1)}`, { auth: 4 }),
      400,
    );
  });

  it("sends the cockpit's week and its goals with the board", async () => {
    const goal = (
      await body<{ goal: { id: string } }>(
        call("POST", "/goals", {
          level: "week",
          period_start: TODAY,
          pillar: "ai",
          title: "Ship the demo",
        }),
        201,
      )
    ).goal;
    const board = onTheWire(
      plannerBoardResponseSchema,
      await body(call("GET", `/board?today=${TODAY}`)),
    );
    expect(board.week).toMatchObject({ start: plannerWeekStartOf(TODAY) });
    expect(board.week?.goals.map((entry) => entry.id)).toEqual([goal.id]);
  });

  it("reads the review, saves its state, Look back and Look forward", async () => {
    const review = onTheWire(
      plannerReviewResponseSchema,
      await body(call("GET", `/review?today=${TODAY}`)),
    );
    expect(review).toMatchObject({
      review_week: REVIEW_WEEK,
      plan_week: PLAN_WEEK,
      state: null,
      ai: false,
    });
    await body(
      call(
        "GET",
        `/review?today=${TODAY}&week=${plannerAddDays(PLAN_WEEK, 7)}`,
      ),
      400,
    );

    onTheWire(
      plannerReviewStateResponseSchema,
      await body(
        call("PATCH", `/review/${REVIEW_WEEK}/state`, { state: { step: 2 } }),
      ),
    );

    const back = onTheWire(
      plannerLookBackResponseSchema,
      await body(
        call("POST", `/review/${REVIEW_WEEK}/look-back`, {
          today: TODAY,
          scores: { auth: 4, ach: 3 },
          question: "Did I get the terms on paper?",
          verdict: { kind: "continue", text: "Continue. The offers moved." },
          goal_results: [],
          memo: "# Week 1: summary\n\nBody",
        }),
      ),
    );
    expect(back.week).toMatchObject({ auth: 4, ach: 3, memo_id: back.memo_id });

    const goalId = crypto.randomUUID();
    const forward = onTheWire(
      plannerCommitResponseSchema,
      await body(
        call("POST", `/review/${REVIEW_WEEK}/look-forward`, {
          today: TODAY,
          goals: [{ id: goalId, pillar: "work", title: "Get the terms" }],
          tasks: [{ ref: "n1", goal_id: goalId, title: "Email Acme" }],
          to_backlog: [],
          question: "Did I sign?",
          settled: [],
          flags: [],
        }),
      ),
    );
    expect(forward.plan_week).toBe(PLAN_WEEK);
    expect(forward.goals.map((goal) => goal.id)).toEqual([goalId]);
    const taskId = forward.created.n1;
    expect(taskId).toMatch(/^tasks\//);

    const status = onTheWire(
      plannerReviewStatusResponseSchema,
      await body(call("GET", `/review/status?today=${TODAY}`)),
    );
    expect(status).toMatchObject({
      review_week: REVIEW_WEEK,
      look_back_done: true,
      look_forward_done: true,
      due: false,
    });

    const board = await body<z.infer<typeof plannerBoardResponseSchema>>(
      call("GET", `/board?today=${TODAY}`),
    );
    expect(board.columns.todo.map((card) => [card.id, card.goal_id])).toEqual([
      [taskId, goalId],
    ]);
    // Monday to Friday the plan week is this week; at the weekend it is next
    // week, which the cockpit shows once it is planned.
    expect(board.week?.start).toBe(PLAN_WEEK);

    const reread = await body<{
      state: unknown;
      summary: { id: string } | null;
    }>(call("GET", `/review?today=${TODAY}`));
    expect(reread.state).toEqual({ step: 2 });
    expect(reread.summary?.id).toBe(back.memo_id);
  });

  it("answers 503 when no model is set up, so the page uses its own drafts", async () => {
    for (const path of ["opening", "coach"]) {
      const error = await body<{ error: { code?: string } }>(
        call(
          "POST",
          `/review/${REVIEW_WEEK}/ai/${path}`,
          path === "coach"
            ? {
                today: TODAY,
                mode: "free",
                messages: [{ role: "user", content: "Hi" }],
              }
            : { today: TODAY },
        ),
        503,
      );
      expect(error.error.code).toBe("ai_unavailable");
    }
    const off = withEnv({
      AI: fakeAi({ answer: "{}" }),
      FLAREMO_REVIEW_AI: "off",
    });
    await body(
      call(
        "POST",
        `/review/${REVIEW_WEEK}/ai/opening`,
        { today: TODAY },
        { env: off },
      ),
      503,
    );
    const review = await body<{ ai: boolean }>(
      call("GET", `/review?today=${TODAY}`, undefined, { env: off }),
    );
    expect(review.ai).toBe(false);
  });

  it("drafts the opening with Workers AI and reads a fenced answer", async () => {
    const calls: FakeAiCall[] = [];
    const ai = withEnv({
      AI: fakeAi({
        calls,
        answer:
          'Here you go:\n```json\n{"recap":"Busy week.","lastq":["Yes","No"],"prompts":[["a","b"],["c","d"]],}\n```',
      }),
    });
    const opening = onTheWire(
      plannerAiOpeningResponseSchema,
      await body(
        call(
          "POST",
          `/review/${REVIEW_WEEK}/ai/opening`,
          { today: TODAY },
          { env: ai },
        ),
      ),
    );
    expect(opening).toEqual({
      recap: "Busy week.",
      lastq: ["Yes", "No"],
      prompts: [["a", "b"], ["c", "d"], [], [], [], [], []],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
    expect(calls[0]?.inputs).toMatchObject({ max_tokens: 1600 });
    const messages = calls[0]?.inputs.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[0]?.content).toContain("Owner's Sunday weekly review");

    const review = await body<{ ai: boolean }>(
      call("GET", `/review?today=${TODAY}`, undefined, { env: ai }),
    );
    expect(review.ai).toBe(true);

    const custom: FakeAiCall[] = [];
    await body(
      call(
        "POST",
        `/review/${REVIEW_WEEK}/ai/close`,
        { today: TODAY, ...ANSWERS },
        {
          env: withEnv({
            AI: fakeAi({ calls: custom, answer: "not json" }),
            FLAREMO_REVIEW_MODEL: "@cf/meta/llama-3.1-8b-instruct",
          }),
        },
      ),
    );
    expect(custom[0]?.model).toBe("@cf/meta/llama-3.1-8b-instruct");
  });

  it("flags clashes tied to the plan's goals", async () => {
    const year = (
      await body<{ goal: { id: string } }>(
        call("POST", "/goals", {
          level: "year",
          period_start: TODAY,
          pillar: "work",
          title: "Stay on better terms",
        }),
        201,
      )
    ).goal;
    const goalId = crypto.randomUUID();
    const check = onTheWire(
      plannerAiCheckResponseSchema,
      await body(
        call(
          "POST",
          `/review/${REVIEW_WEEK}/ai/check`,
          {
            today: TODAY,
            goals: [
              {
                id: goalId,
                pillar: "work",
                title: "Sign with Acme",
                tasks: [],
              },
            ],
            settled: [],
          },
          {
            env: withEnv({
              AI: fakeAi({
                answer:
                  '{"flags":[{"goal":"work","with_level":"year","with_goal":"work","why":"The year goal says stay."}]}',
              }),
            }),
          },
        ),
      ),
    );
    expect(check.flags).toEqual([
      {
        goal_id: goalId,
        pillar: "work",
        with_goal_id: year.id,
        with_label: "Year · Work",
        why: "The year goal says stay.",
      },
    ]);
  });

  it("streams the coach without its control line", async () => {
    const coach = (mode: string, pieces: string[]) =>
      call(
        "POST",
        `/review/${REVIEW_WEEK}/ai/coach`,
        {
          today: TODAY,
          mode,
          messages: [{ role: "user", content: "I met Acme." }],
        },
        { env: withEnv({ AI: fakeAi({ pieces }) }) },
      );

    const probing = await coach("free", [
      "Which ",
      "number did you get?",
      "\n@",
      '@ {"advance": false}',
    ]);
    expect(probing.status).toBe(200);
    expect(probing.headers.get("content-type")).toContain(
      "application/x-ndjson",
    );
    const first = await lines(probing);
    expect(said(first).trim()).toBe("Which number did you get?");
    expect(first.at(-1)).toEqual({ done: true, advance: false });

    const forced = await lines(await coach("force", ["Noted. Moving on."]));
    expect(said(forced)).toBe("Noted. Moving on.");
    expect(forced.at(-1)).toEqual({ done: true, advance: true });

    const plain = await lines(
      await coach("free", ["That is specific enough."]),
    );
    expect(plain.at(-1)).toEqual({ done: true, advance: true });
  });

  it("streams the memo from its title and reports a failed model", async () => {
    const request = {
      today: TODAY,
      ...ANSWERS,
      scores: { auth: 4, ach: 3 },
      question: "Did I sign?",
      verdict: { kind: "continue", text: "Continue. Moving." },
      recommended: "continue",
      drafts: {
        auth_evidence: "",
        ach_evidence: "",
        pattern: "",
        risk: "",
        opportunity: "",
      },
    };
    const memo = await lines(
      await call("POST", `/review/${REVIEW_WEEK}/ai/memo`, request, {
        env: withEnv({
          AI: fakeAi({
            pieces: [
              "Here is your memo:\n\n#",
              " Week 41: Oct",
              "ober\n\nBody",
            ],
          }),
        }),
      }),
    );
    expect(said(memo)).toBe("# Week 41: October\n\nBody");
    expect(memo.at(-1)).toEqual({ done: true });

    const failed = await lines(
      await call("POST", `/review/${REVIEW_WEEK}/ai/memo`, request, {
        env: withEnv({ AI: fakeAi({ fail: true }) }),
      }),
    );
    expect(failed).toEqual([{ error: "failed" }]);
  });

  it("uses Anthropic when its key is set, without leaking the key", async () => {
    const realFetch = globalThis.fetch;
    const sent: Array<{
      url: string;
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.anthropic.com/")) {
        return realFetch(input, init);
      }
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push({ url, headers: new Headers(init?.headers), body: payload });
      if (payload.stream) {
        const events = [
          { type: "message_start" },
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Who " },
          },
          {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "decided?" },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        content: [
          {
            type: "text",
            text: '{"recap":"From Claude.","lastq":[],"prompts":[]}',
          },
        ],
      });
    });
    const anthropic = withEnv({ ANTHROPIC_API_KEY: "test-anthropic-key" });

    const opening = await body<{ recap: string }>(
      call(
        "POST",
        `/review/${REVIEW_WEEK}/ai/opening`,
        { today: TODAY },
        { env: anthropic },
      ),
    );
    expect(opening.recap).toBe("From Claude.");
    expect(sent[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]?.headers.get("x-api-key")).toBe("test-anthropic-key");
    expect(sent[0]?.body).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 1600,
    });
    expect(typeof sent[0]?.body.system).toBe("string");
    expect(
      ((sent[0]?.body.messages ?? []) as Array<{ role: string }>).map(
        (message) => message.role,
      ),
    ).toEqual(["user"]);

    const coach = await lines(
      await call(
        "POST",
        `/review/${REVIEW_WEEK}/ai/coach`,
        {
          today: TODAY,
          mode: "free",
          messages: [
            { role: "assistant", content: "What did you accomplish?" },
            { role: "user", content: "Signed." },
          ],
        },
        { env: anthropic },
      ),
    );
    expect(said(coach)).toBe("Who decided?");
    expect(coach.at(-1)).toEqual({ done: true, advance: false });
    // The chat starts with the owner's turn, as Anthropic requires.
    expect(
      ((sent[1]?.body.messages ?? []) as Array<{ role: string }>).map(
        (message) => message.role,
      ),
    ).toEqual(["user"]);

    for (const call of vi.mocked(console.error).mock.calls) {
      expect(JSON.stringify(call)).not.toContain("test-anthropic-key");
    }
  });

  it("keeps other people out", async () => {
    const goal = (
      await body<{ goal: { id: string } }>(
        call("POST", "/goals", {
          level: "north_star",
          title: "Freedom",
        }),
        201,
      )
    ).goal;
    const member = await harness.createActivatedMember(
      "member@example.com",
      "Member",
    );
    const asMember = { cookie: member.cookie, origin: ORIGIN };
    await body(
      call(
        "PATCH",
        `/goals/${goal.id}`,
        { title: "Mine" },
        { headers: asMember },
      ),
      404,
    );
    const theirs = await body<{ goals: unknown[]; north_star: unknown }>(
      call(
        "GET",
        `/goals?year=${TODAY.slice(0, 4)}&today=${TODAY}`,
        undefined,
        { headers: asMember },
      ),
    );
    expect(theirs.north_star).toBeNull();

    for (const [method, path, payload] of [
      ["GET", `/goals?year=${TODAY.slice(0, 4)}&today=${TODAY}`, undefined],
      ["POST", "/goals", { level: "north_star", title: "x" }],
      ["GET", `/review?today=${TODAY}`, undefined],
      ["GET", `/review/status?today=${TODAY}`, undefined],
      ["PATCH", `/review/${REVIEW_WEEK}/state`, { state: {} }],
      ["POST", `/review/${REVIEW_WEEK}/ai/opening`, { today: TODAY }],
    ] as const) {
      const res = await call(method, path, payload, { headers: {} });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });
});
