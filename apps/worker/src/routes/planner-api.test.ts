import {
  type PlannerBoardResponse,
  type PlannerCommentDto,
  type PlannerCommentListResponse,
  type PlannerCommentResponse,
  type PlannerCreateTaskResponse,
  type PlannerHistoryRangeResponse,
  type PlannerRolloverResponse,
  type PlannerRollupResponse,
  type PlannerTaskDetailResponse,
  type PlannerTaskHistoryResponse,
  type PlannerTaskPlanResponse,
  type PlannerTreeNodeResponse,
  type PlannerTreeResponse,
  plannerBoardResponseSchema,
  plannerColumnSchema,
  plannerCommentBodyMax,
  plannerCommentListResponseSchema,
  plannerCommentResponseSchema,
  plannerCreateTaskResponseSchema,
  plannerDeleteCommentResponseSchema,
  plannerHistoryRangeResponseSchema,
  plannerPeriodStart,
  plannerRolloverResponseSchema,
  plannerRollupResponseSchema,
  plannerTaskDetailResponseSchema,
  plannerTaskHistoryResponseSchema,
  plannerTaskPlanResponseSchema,
  plannerTreeNodeResponseSchema,
  plannerTreeResponseSchema,
} from "@flaremo/contracts";
import type { FlareMoDb, UserRow } from "@flaremo/db";
import { createDb } from "@flaremo/db";
import { applyPlannerMigrations } from "@flaremo/db/src/planner-migrations";
import { ensureSingleUser } from "@flaremo/domain";
import { plannerColumns } from "@flaremo/domain/src/planner";
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
import { createFlareMoApp } from "../index";
import { createAppTestHarness } from "../test-support/app";
import { createTestRuntime, fetchWorker } from "../test-support/runtime";
import { bootstrapAndSignIn } from "../test-support/sign-in";
import { appApi } from "./app-api";

// HTTP tests for the planning cockpit API (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, sections 4, 6 and 8).
//
// Every request goes through the real Worker entry with real auth: the owner's
// cookie session, a second member's session, a personal access token, and no
// credentials at all. The planner migrations are applied on top of upstream's,
// in this file, exactly as planner-upstream-compat.test.ts does.
//
// "Today" is the real UTC date. The server only accepts a client date within one
// day of its own clock, and the HTTP layer gives the tests no way to fake that
// clock, so every date below is derived from `TODAY` (computed once per test).
//
// One runtime serves the whole file: signing in costs a password hash, so booting
// per test would take minutes. The users and their sessions stay; every task,
// project, activity and planner row is deleted before each test.

const ORIGIN = "http://flaremo.test";
const API = "/api/app/planner";

// Children before parents: task_activity references tasks, tasks reference
// projects. The planner tables have no foreign keys to them.
const RESET_TABLES = [
  "planner_task_event",
  "planner_task_plan",
  "planner_task_seen",
  "planner_sync_state",
  "planner_project_node",
  "planner_task_comment",
  "task_activity",
  "tasks",
  "projects",
] as const;

const utcDay = () => new Date().toISOString().slice(0, 10);

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

type Context = {
  runtime: Miniflare;
  d1: D1Database;
  env: Env;
  cookie: string;
};

type RequestOptions = {
  body?: unknown;
  headers?: Record<string, string>;
  env?: Env;
};

describe("planner API", () => {
  let ctx: Context;
  let db: FlareMoDb;
  let owner: UserRow;
  let TODAY: string;

  const harness = createAppTestHarness(() => ({
    env: ctx.env,
    sessionCookie: ctx.cookie,
  }));

  beforeAll(async () => {
    const {
      runtime,
      db: d1,
      env,
    } = await createTestRuntime({
      name: "flaremo-planner-api",
      env: { FLAREMO_EMBEDDING_PROVIDER: "none" },
    });
    await applyPlannerMigrations(d1);
    ctx = { runtime, d1, env, cookie: await bootstrapAndSignIn(env) };
    db = createDb(ctx.d1);
    owner = await ensureSingleUser(db, {
      email: "owner@example.com",
      name: "Owner",
    });
  });

  afterAll(async () => {
    await ctx.runtime.dispose();
  });

  beforeEach(async () => {
    // The plan-write failure test logs one error on purpose; keep the output clean.
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await ctx.d1.batch(
      RESET_TABLES.map((table) => ctx.d1.prepare(`DELETE FROM ${table}`)),
    );
    TODAY = utcDay();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- requests --------------------------------------------------------------

  const url = (path: string) => `http://flaremo.test${path}`;

  /** The owner's cookie session; the harness adds the Origin to state changes. */
  const send = (method: string, path: string, body?: unknown) =>
    harness.fetchApp(url(path), {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });

  /** A request with exactly the headers given: no cookie and no Origin unless asked. */
  const request = (
    method: string,
    path: string,
    options: RequestOptions = {},
  ) =>
    fetchWorker(
      new Request(url(path), {
        method,
        headers: {
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...options.headers,
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      }),
      options.env ?? ctx.env,
    );

  const asOwnerCookie = (extra: Record<string, string> = {}) => ({
    cookie: ctx.cookie,
    origin: ORIGIN,
    ...extra,
  });

  /** The response body, asserting the status. The text goes in the failure message. */
  async function body<T>(
    response: Response | Promise<Response>,
    status = 200,
  ): Promise<T> {
    const res = await response;
    const text = await res.text();
    expect(res.status, text).toBe(status);
    return JSON.parse(text) as T;
  }

  /** A domain error: its status, and the `{ error: { message } }` envelope. */
  async function domainError(
    response: Response | Promise<Response>,
    status: number,
    messagePart?: string,
  ): Promise<string> {
    const res = await response;
    const text = await res.text();
    expect(res.status, text).toBe(status);
    const parsed = JSON.parse(text) as { error?: { message?: string } };
    const message = parsed.error?.message;
    expect(typeof message, text).toBe("string");
    if (messagePart) expect(message).toContain(messagePart);
    return message ?? "";
  }

  /**
   * Parses a response body with its contract schema and checks nothing was lost:
   * zod drops keys the schema does not know, so a body with an extra key (or a
   * wrong type) fails the comparison. This is what keeps the contract exact.
   */
  function onTheWire<T extends z.ZodType>(
    schema: T,
    value: unknown,
  ): z.infer<T> {
    const parsed = schema.parse(value);
    expect(parsed).toEqual(value);
    return parsed;
  }

  const bare = (id: string) => id.replace(/^(tasks|projects)\//, "");

  // --- fixtures --------------------------------------------------------------

  async function createProject(name: string): Promise<string> {
    const created = await body<{ project: { id: string } }>(
      send("POST", "/api/app/projects", { name }),
      201,
    );
    return created.project.id;
  }

  /** Through upstream's own route: no planner involved. */
  async function createUpstreamTask(
    title: string,
    extra: Record<string, unknown> = {},
  ) {
    const created = await body<{ task: PlannerTaskPlanResponse["task"] }>(
      send("POST", "/api/app/tasks", { title, ...extra }),
      201,
    );
    return created.task;
  }

  /** Through the planner route. */
  async function createTask(
    title: string,
    extra: Record<string, unknown> = {},
  ) {
    const created = await body<PlannerCreateTaskResponse>(
      send("POST", `${API}/tasks`, { title, today: TODAY, ...extra }),
      201,
    );
    return created.task;
  }

  /** A comment through the planner route, as the owner. */
  async function createComment(
    taskId: string,
    text: string,
  ): Promise<PlannerCommentDto> {
    const created = await body<PlannerCommentResponse>(
      send("POST", `${API}/tasks/${bare(taskId)}/comments`, { body: text }),
      201,
    );
    return created.comment;
  }

  const patchTask = (id: string, change: Record<string, unknown>) =>
    send("PATCH", `${API}/tasks/${bare(id)}`, { today: TODAY, ...change });

  const patchTaskOk = (id: string, change: Record<string, unknown>) =>
    body<PlannerTaskPlanResponse>(patchTask(id, change));

  const board = (query: Record<string, string> = {}) =>
    send(
      "GET",
      `${API}/board?${new URLSearchParams({ today: TODAY, ...query })}`,
    );

  const boardOk = async (query: Record<string, string> = {}) =>
    onTheWire(
      plannerBoardResponseSchema,
      await body<PlannerBoardResponse>(board(query)),
    ) as PlannerBoardResponse;

  const titles = (cards: Array<{ title: string }>) =>
    cards.map((card) => card.title);

  const history = async (taskId: string) =>
    onTheWire(
      plannerTaskHistoryResponseSchema,
      await body<PlannerTaskHistoryResponse>(
        send("GET", `${API}/tasks/${bare(taskId)}/history`),
      ),
    ) as PlannerTaskHistoryResponse;

  // --- database --------------------------------------------------------------

  async function rows<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ): Promise<T[]> {
    return (
      await ctx.d1
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results;
  }

  const run = (sql: string, ...params: unknown[]) =>
    ctx.d1
      .prepare(sql)
      .bind(...params)
      .run();

  const count = async (table: string) =>
    (await rows<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`))[0]?.n ??
    -1;

  /**
   * Runs `work` with a planner table renamed away, to make one statement fail
   * for real, and always renames it back: the runtime is shared by every test.
   */
  async function withTableRenamedAway(
    table: string,
    work: () => Promise<void>,
  ): Promise<void> {
    await run(`ALTER TABLE ${table} RENAME TO ${table}_off`);
    try {
      await work();
    } finally {
      await run(`ALTER TABLE ${table}_off RENAME TO ${table}`);
    }
  }

  /** The history sync skips a run under 30 seconds after the last one. */
  const expireSyncDebounce = () =>
    run(
      "UPDATE planner_sync_state SET last_sync_at = '2000-01-01T00:00:00.000Z'",
    );

  // --- credentials -----------------------------------------------------------

  async function createPat(): Promise<string> {
    const created = await body<{ token: string }>(
      send("POST", "/api/app/account/personal-access-tokens", {
        name: "planner-test",
        expires_in_days: 30,
      }),
      201,
    );
    expect(created.token).toMatch(/^memos_pat_/);
    return created.token;
  }

  // The second user's account lives for the whole file, like the owner's; only
  // their rows are reset between tests.
  let memberSession: { id: string; cookie: string } | undefined;

  async function createMember() {
    memberSession ??= await harness.createActivatedMember(
      "member@example.com",
      "Member",
    );
    const { cookie } = memberSession;
    const asMember = (method: string, path: string, requestBody?: unknown) =>
      request(method, path, {
        body: requestBody,
        headers: { cookie, origin: ORIGIN },
      });
    return { ...memberSession, asMember };
  }

  // --- the endpoints, for the credential tables --------------------------------

  /** Every route with a body that is valid, so a failure comes from auth alone. */
  const endpoints = (
    taskId = "tasks/none",
    projectId = "projects/none",
    commentId = "none",
  ) => {
    const range = `from=${TODAY}&to=${TODAY}`;
    return [
      { method: "GET", path: `/board?today=${TODAY}` },
      { method: "POST", path: "/rollover", body: { today: TODAY } },
      {
        method: "POST",
        path: "/tasks",
        body: { title: "Never created", today: TODAY },
      },
      {
        method: "PATCH",
        path: `/tasks/${bare(taskId)}`,
        body: { today: TODAY, title: "Never renamed" },
      },
      { method: "GET", path: `/tasks/${bare(taskId)}` },
      { method: "GET", path: `/tasks/${bare(taskId)}/history` },
      { method: "GET", path: `/tasks/${bare(taskId)}/comments` },
      {
        method: "POST",
        path: `/tasks/${bare(taskId)}/comments`,
        body: { body: "Never commented" },
      },
      {
        method: "PATCH",
        path: `/comments/${commentId}`,
        body: { body: "Never edited" },
      },
      { method: "DELETE", path: `/comments/${commentId}` },
      { method: "GET", path: `/history?${range}` },
      { method: "GET", path: "/tree" },
      {
        method: "PATCH",
        path: `/tree/${bare(projectId)}`,
        body: { level: "area" },
      },
      { method: "GET", path: `/tree/${bare(projectId)}/rollup?${range}` },
    ] as const;
  };

  const mutations = (taskId?: string, projectId?: string, commentId?: string) =>
    endpoints(taskId, projectId, commentId).filter(
      (entry) => entry.method !== "GET",
    );

  // ===========================================================================
  // Authentication and the Origin rules
  // ===========================================================================

  describe("authentication", () => {
    it("answers 401 to every endpoint without credentials, with or without an Origin", async () => {
      const headerSets: Array<Record<string, string>> = [
        {},
        { origin: ORIGIN },
      ];
      for (const entry of endpoints()) {
        const requestBody = "body" in entry ? entry.body : undefined;
        for (const headers of headerSets) {
          const response = await request(entry.method, `${API}${entry.path}`, {
            body: requestBody,
            headers,
          });
          expect(response.status, `${entry.method} ${entry.path}`).toBe(401);
        }
      }
      // A bearer that is not a real token is no better than none.
      for (const entry of endpoints()) {
        const response = await request(entry.method, `${API}${entry.path}`, {
          body: "body" in entry ? entry.body : undefined,
          headers: { authorization: "Bearer memos_pat_not_a_real_token" },
        });
        expect(response.status, `${entry.method} ${entry.path}`).toBe(401);
      }
      // Nothing was written along the way.
      expect(await count("tasks")).toBe(0);
      expect(await count("planner_task_event")).toBe(0);
    });

    it("checks the credential before today's bounds, so a stranger learns nothing about them", async () => {
      const far = shiftDay(TODAY, 30);
      expect((await request("GET", `${API}/board?today=${far}`)).status).toBe(
        401,
      );
      expect(
        (
          await request("POST", `${API}/rollover`, {
            body: { today: far },
            headers: { origin: ORIGIN },
          })
        ).status,
      ).toBe(401);
    });

    it("refuses a cookie-session state change without FlareMo's Origin, and applies it with one", async () => {
      const task = await createTask("Origin check");
      const projectId = await createProject("Origin project");
      const comment = await createComment(task.id, "Origin comment");

      for (const entry of mutations(task.id, projectId, comment.id)) {
        const label = `${entry.method} ${entry.path}`;
        for (const origin of [
          undefined,
          "https://untrusted.example",
          "http://flaremo.test.evil.example",
          "null",
        ]) {
          const response = await request(entry.method, `${API}${entry.path}`, {
            body: entry.body,
            headers: {
              cookie: ctx.cookie,
              ...(origin === undefined ? {} : { origin }),
            },
          });
          expect(response.status, `${label} origin=${origin}`).toBe(403);
        }
      }
      // Not one of the refused requests changed anything.
      expect(await count("tasks")).toBe(1);
      expect(
        (await rows<{ title: string }>("SELECT title FROM tasks"))[0]?.title,
      ).toBe("Origin check");
      expect(await count("planner_project_node")).toBe(0);
      // Nor did any of them touch the comment.
      expect(
        await rows<{ body: string; deleted_at: string | null }>(
          "SELECT body, deleted_at FROM planner_task_comment",
        ),
      ).toEqual([{ body: "Origin comment", deleted_at: null }]);

      // The same requests with the right Origin go through.
      for (const entry of mutations(task.id, projectId, comment.id)) {
        const response = await request(entry.method, `${API}${entry.path}`, {
          body: entry.body,
          headers: asOwnerCookie(),
        });
        expect(response.status, `${entry.method} ${entry.path}`).toBeLessThan(
          300,
        );
      }
      expect(await count("tasks")).toBe(2);
      // The new comment is added, the first is edited and then deleted.
      expect(
        await rows<{ body: string; deleted_at: string | null }>(
          "SELECT body, deleted_at FROM planner_task_comment ORDER BY rowid",
        ).then((all) => all.map((row) => [row.body, row.deleted_at !== null])),
      ).toEqual([
        ["Never edited", true],
        ["Never commented", false],
      ]);
    });

    it("lets a cookie session read without an Origin: only state changes need one", async () => {
      const task = await createTask("Readable");
      for (const entry of endpoints(task.id).filter(
        (e) => e.method === "GET",
      )) {
        if (entry.path.includes("/tree/")) continue; // needs a real project
        const response = await request("GET", `${API}${entry.path}`, {
          headers: { cookie: ctx.cookie },
        });
        expect(response.status, entry.path).toBe(200);
      }
    });

    it("accepts a personal access token without an Origin, and refuses an untrusted one", async () => {
      const token = await createPat();
      const bearer = { authorization: `Bearer ${token}` };

      // No Origin: scripts and MCP clients do not send one.
      const created = await body<PlannerCreateTaskResponse>(
        request("POST", `${API}/tasks`, {
          body: {
            title: "By agent",
            plan: { horizon: "week", day: TODAY },
            today: TODAY,
          },
          headers: bearer,
        }),
        201,
      );
      expect(created.plan?.horizon).toBe("week");
      // The deployment's own Origin is fine too.
      await body(
        request("POST", `${API}/rollover`, {
          body: { today: TODAY },
          headers: { ...bearer, origin: ORIGIN },
        }),
      );
      // Reads work without one.
      const read = await body<PlannerBoardResponse>(
        request("GET", `${API}/board?today=${TODAY}`, { headers: bearer }),
      );
      expect(titles(read.columns.todo)).toEqual(["By agent"]);

      // An Origin that is not on the allow-list is a 403, reads included.
      for (const [method, path, requestBody] of [
        ["GET", `${API}/board?today=${TODAY}`, undefined],
        ["POST", `${API}/tasks`, { title: "Never", today: TODAY }],
        [
          "PATCH",
          `${API}/tasks/${bare(created.task.id)}`,
          { today: TODAY, title: "Never" },
        ],
      ] as const) {
        const response = await request(method, path, {
          body: requestBody,
          headers: { ...bearer, origin: "https://untrusted.example" },
        });
        expect(response.status, `${method} ${path}`).toBe(403);
      }
      expect(await count("tasks")).toBe(1);
    });

    // Upstream's `resolveActor` (copied into planner-api.ts) looks for the
    // `memos_pat_` prefix on the whole Authorization header, which starts with
    // "Bearer ", so the token hint it was written to add is never produced and a
    // PAT is an agent with no name. That is upstream's to fix. This test does not
    // pin the name; it pins that the planner labels a token exactly as upstream's
    // own task route does, so one agent is one actor across both.
    it("attributes a token's writes to an agent, labelled as upstream's task route labels it", async () => {
      const token = await createPat();
      const bearer = { authorization: `Bearer ${token}` };
      const actorsOf = (query: string, ...params: unknown[]) =>
        rows<{ actor_type: string; actor_name: string | null }>(
          query,
          ...params,
        );

      const viaUpstream = await body<{ task: { id: string } }>(
        request("POST", "/api/app/tasks", {
          body: { title: "Through upstream" },
          headers: bearer,
        }),
        201,
      );
      const [label, ...extra] = await actorsOf(
        "SELECT actor_type, actor_name FROM task_activity WHERE task_id = ?",
        viaUpstream.task.id,
      );
      expect(extra).toEqual([]);
      expect(label?.actor_type).toBe("agent");

      const created = await body<PlannerCreateTaskResponse>(
        request("POST", `${API}/tasks`, {
          body: {
            title: "Through the planner",
            plan: { horizon: "week", day: TODAY },
            today: TODAY,
          },
          headers: bearer,
        }),
        201,
      );
      await body(
        request("PATCH", `${API}/tasks/${bare(created.task.id)}`, {
          body: { today: TODAY, title: "Renamed by agent", column: "doing" },
          headers: bearer,
        }),
      );

      // The planner's own events and upstream's activity rows written by the
      // planner route all carry the same actor as upstream's route gave the token.
      const planner = await actorsOf(
        "SELECT actor_type, actor_name FROM planner_task_event WHERE source = 'planner'",
      );
      expect(planner.length).toBeGreaterThan(0);
      const upstream = await actorsOf(
        "SELECT actor_type, actor_name FROM task_activity WHERE task_id = ?",
        created.task.id,
      );
      expect(upstream.length).toBe(3); // created, updated, status_changed
      for (const actor of [...planner, ...upstream]) {
        expect(actor).toEqual(label);
      }

      // The archive shows the same actor to the cockpit.
      await expireSyncDebounce();
      const events = (await history(created.task.id)).events;
      expect(events.length).toBeGreaterThan(3);
      expect(events.every((event) => event.actor_type === "agent")).toBe(true);
    });

    it("records the owner as a user, with no name, for a cookie session", async () => {
      const task = await createTask("By owner", {
        plan: { horizon: "day", day: TODAY },
      });
      const events = await rows<{
        actor_type: string;
        actor_name: string | null;
      }>(
        "SELECT actor_type, actor_name FROM planner_task_event WHERE task_id = ? AND source = 'planner'",
        task.id,
      );
      expect(events).toEqual([{ actor_type: "user", actor_name: null }]);
    });
  });

  // ===========================================================================
  // today
  // ===========================================================================

  describe("today", () => {
    it("must be within one day of the server's date, on every endpoint that takes it", async () => {
      const task = await createTask("Dated");
      for (const today of [shiftDay(TODAY, 2), shiftDay(TODAY, -2)]) {
        const message = await domainError(
          board({ today }),
          400,
          "within one day",
        );
        expect(message).toContain("today");
        await domainError(
          send("POST", `${API}/rollover`, { today }),
          400,
          "within one day",
        );
        await domainError(
          send("POST", `${API}/tasks`, { title: "Never created", today }),
          400,
          "within one day",
        );
        await domainError(
          send("PATCH", `${API}/tasks/${bare(task.id)}`, {
            today,
            title: "Never renamed",
          }),
          400,
          "within one day",
        );
      }
      expect(await count("tasks")).toBe(1);
      expect(
        (await rows<{ title: string }>("SELECT title FROM tasks"))[0]?.title,
      ).toBe("Dated");
    });

    it("accepts the day before and the day after, which cover every time zone", async () => {
      for (const today of [shiftDay(TODAY, -1), TODAY, shiftDay(TODAY, 1)]) {
        const result = await body<PlannerBoardResponse>(board({ today }));
        expect(result.today).toBe(today);
        expect(result.periods).toEqual({
          day: today,
          week: plannerPeriodStart("week", today),
          month: plannerPeriodStart("month", today),
        });
        await body(send("POST", `${API}/rollover`, { today }));
      }
    });

    it("is a 400 when missing or not a real day", async () => {
      for (const today of [
        "",
        "tomorrow",
        "2026-02-30",
        "2026-13-01",
        "10/05/2026",
      ]) {
        expect((await board({ today })).status, today).toBe(400);
        expect(
          (await send("POST", `${API}/rollover`, { today })).status,
          today,
        ).toBe(400);
      }
      expect((await send("GET", `${API}/board`)).status).toBe(400);
      expect((await send("POST", `${API}/rollover`, {})).status).toBe(400);
      expect(
        (await send("POST", `${API}/tasks`, { title: "No today" })).status,
      ).toBe(400);
      expect(await count("tasks")).toBe(0);
    });
  });

  // ===========================================================================
  // Validation
  // ===========================================================================

  describe("validation", () => {
    it("answers 400 and writes nothing for a bad horizon, day, level, column and key", async () => {
      const task = await createTask("Untouched");
      const projectId = await createProject("Untouched project");
      const taskPath = `${API}/tasks/${bare(task.id)}`;
      const treePath = `${API}/tree/${bare(projectId)}`;
      const eventsBefore = await count("planner_task_event");

      const bad: Array<[string, string, unknown]> = [
        // plans
        [
          "POST",
          `${API}/tasks`,
          { title: "x", today: TODAY, plan: { horizon: "year", day: TODAY } },
        ],
        [
          "POST",
          `${API}/tasks`,
          {
            title: "x",
            today: TODAY,
            plan: { horizon: "week", day: "2026-02-30" },
          },
        ],
        [
          "POST",
          `${API}/tasks`,
          { title: "x", today: TODAY, plan: { horizon: "week" } },
        ],
        [
          "PATCH",
          taskPath,
          { today: TODAY, plan: { horizon: "Week", day: TODAY } },
        ],
        [
          "PATCH",
          taskPath,
          { today: TODAY, plan: { horizon: "week", day: "nope" } },
        ],
        // columns
        ["PATCH", taskPath, { today: TODAY, column: "archive" }],
        ["PATCH", taskPath, { today: TODAY, column: "Doing" }],
        // a column move sets the plan itself
        [
          "PATCH",
          taskPath,
          {
            today: TODAY,
            column: "todo",
            plan: { horizon: "day", day: TODAY },
          },
        ],
        ["PATCH", taskPath, { today: TODAY, column: "backlog", plan: null }],
        // nothing to change, and keys the planner does not take
        ["PATCH", taskPath, { today: TODAY }],
        ["PATCH", taskPath, { today: TODAY, status: "done" }],
        ["PATCH", taskPath, { today: TODAY, sort_order: 3 }],
        ["PATCH", taskPath, { today: TODAY, title: "x", typo: true }],
        ["PATCH", taskPath, { today: TODAY, dropped: "yes" }],
        ["POST", `${API}/tasks`, { title: "x", today: TODAY, status: "done" }],
        // task fields use upstream's own limits
        ["PATCH", taskPath, { today: TODAY, title: "   " }],
        ["PATCH", taskPath, { today: TODAY, due_at: "tomorrow" }],
        ["POST", `${API}/tasks`, { title: "   ", today: TODAY }],
        // the goal tree
        ["PATCH", treePath, { level: "Quarter" }],
        ["PATCH", treePath, { level: "1st" }],
        ["PATCH", treePath, { level: "a".repeat(25) }],
        ["PATCH", treePath, {}],
        ["PATCH", treePath, { period_start: "2026-02-30" }],
        ["PATCH", treePath, { sort_order: 1.5 }],
        ["PATCH", treePath, { name: "Renamed" }],
        ["POST", `${API}/rollover`, { today: TODAY, extra: 1 }],
      ];
      for (const [method, path, requestBody] of bad) {
        const response = await send(method, path, requestBody);
        expect(
          response.status,
          `${method} ${path} ${JSON.stringify(requestBody)}`,
        ).toBe(400);
      }
      expect(await count("tasks")).toBe(1);
      expect(
        (await rows<{ title: string }>("SELECT title FROM tasks"))[0]?.title,
      ).toBe("Untouched");
      expect(await count("planner_task_event")).toBe(eventsBefore);
      expect(await count("planner_task_plan")).toBe(0);
      expect(await count("planner_project_node")).toBe(0);
    });

    it("answers 400 for a malformed JSON body and for query parameters that do not parse", async () => {
      const malformed = await request("POST", `${API}/tasks`, {
        headers: {
          ...asOwnerCookie(),
          "content-type": "application/json",
        },
      });
      expect(malformed.status).toBe(400);
      const notJson = await fetchWorker(
        new Request(url(`${API}/rollover`), {
          method: "POST",
          headers: { ...asOwnerCookie(), "content-type": "application/json" },
          body: "{not json",
        }),
        ctx.env,
      );
      expect(notJson.status).toBe(400);

      const projectId = await createProject("Ranged project");
      const day = TODAY;
      for (const query of [
        // the board
        `${API}/board?today=${TODAY}&done_days=abc`,
        `${API}/board?today=${TODAY}&done_days=-1`,
        `${API}/board?today=${TODAY}&done_days=1.5`,
        `${API}/board?today=${TODAY}&done_days=`,
        `${API}/board?today=${TODAY}&done_days=3651`,
        `${API}/board?today=${TODAY}&include_dropped=maybe`,
        // ranges
        `${API}/history`,
        `${API}/history?from=${day}`,
        `${API}/history?from=${shiftDay(day, 1)}&to=${day}`,
        `${API}/history?from=2026-02-30&to=${day}`,
        `${API}/tree/${bare(projectId)}/rollup?from=${shiftDay(day, 1)}&to=${day}`,
        `${API}/tree/${bare(projectId)}/rollup?from=${day}`,
      ]) {
        expect((await send("GET", query)).status, query).toBe(400);
      }
    });

    it("uses the domain's envelope for what only the domain can judge", async () => {
      const task = await createTask("Past plan");
      const yesterday = shiftDay(TODAY, -1);

      const create = await domainError(
        send("POST", `${API}/tasks`, {
          title: "Never created",
          today: TODAY,
          plan: { horizon: "day", day: yesterday },
        }),
        400,
        "current period",
      );
      expect(create).toContain("cannot start before");
      // A plan rejected up front must not leave a task behind.
      expect(await count("tasks")).toBe(1);

      await domainError(
        patchTask(task.id, { plan: { horizon: "day", day: yesterday } }),
        400,
        "current period",
      );
      await domainError(
        send("GET", `${API}/board?today=${TODAY}&done_days=3651`),
        400,
        "done_days",
      );
    });
  });

  // ===========================================================================
  // GET /board
  // ===========================================================================

  describe("GET /board", () => {
    it("groups the user's tasks into the four columns, with plan, project and the dropped list on request", async () => {
      const home = await createProject("Home");
      await createTask("Backlog task");
      await createUpstreamTask("Made in /projects");
      await createTask("Planned this week", {
        plan: { horizon: "week", day: TODAY },
      });
      await createTask("Planned today", {
        plan: { horizon: "day", day: TODAY },
        due_at: shiftDay(TODAY, 3),
        project_id: home,
        priority: "high",
      });
      const doing = await createTask("In progress");
      await patchTaskOk(doing.id, { column: "doing" });
      const done = await createTask("Finished");
      await patchTaskOk(done.id, { column: "done" });
      const dropped = await createTask("Dropped", {
        plan: { horizon: "week", day: TODAY },
        due_at: shiftDay(TODAY, 5),
      });
      await patchTaskOk(dropped.id, { dropped: true });

      const result = await boardOk();

      // Newest backlog first. To Do puts the plan that ends soonest on top.
      expect(titles(result.columns.backlog)).toEqual([
        "Made in /projects",
        "Backlog task",
      ]);
      expect(titles(result.columns.todo)).toEqual([
        "Planned today",
        "Planned this week",
      ]);
      expect(titles(result.columns.doing)).toEqual(["In progress"]);
      expect(titles(result.columns.done)).toEqual(["Finished"]);
      expect(result.columns.other).toEqual([]);
      expect(result.columns).not.toHaveProperty("dropped");
      expect(result).toMatchObject({
        today: TODAY,
        history: "ok",
        truncated: false,
        periods: {
          day: TODAY,
          week: plannerPeriodStart("week", TODAY),
          month: plannerPeriodStart("month", TODAY),
        },
      });

      const today = result.columns.todo[0];
      expect(today).toMatchObject({
        project_id: home,
        project_name: "Home",
        priority: "high",
        due_at: shiftDay(TODAY, 3),
        horizon: "day",
        period_start: TODAY,
        carry_count: 0,
        dropped_at: null,
        status: "todo",
      });
      // A card never carries the notes.
      expect(today).not.toHaveProperty("notes");
      expect(result.columns.backlog[0]).toMatchObject({
        horizon: null,
        period_start: null,
        carry_count: 0,
        project_name: null,
      });

      const withDropped = await boardOk({ include_dropped: "true" });
      expect(titles(withDropped.columns.dropped ?? [])).toEqual(["Dropped"]);
      // Dropping kept the plan and cleared the due date.
      expect(withDropped.columns.dropped?.[0]).toMatchObject({
        horizon: "week",
        due_at: null,
      });
      expect(
        await boardOk({ include_dropped: "false" }).then(
          (value) => "dropped" in value.columns,
        ),
      ).toBe(false);
    });

    it("limits the Done column to the window asked for", async () => {
      const old = await createTask("Finished long ago");
      await patchTaskOk(old.id, { column: "done" });
      const fresh = await createTask("Finished now");
      await patchTaskOk(fresh.id, { column: "done" });
      await run(
        "UPDATE tasks SET completed_at = ?, updated_at = ? WHERE id = ?",
        `${shiftDay(TODAY, -30)}T12:00:00.000Z`,
        `${shiftDay(TODAY, -30)}T12:00:00.000Z`,
        old.id,
      );

      expect(titles((await boardOk()).columns.done)).toEqual(["Finished now"]);
      expect(titles((await boardOk({ done_days: "14" })).columns.done)).toEqual(
        ["Finished now"],
      );
      expect(
        titles((await boardOk({ done_days: "60" })).columns.done).sort(),
      ).toEqual(["Finished long ago", "Finished now"]);
    });

    it("shows a user only their own tasks", async () => {
      await createTask("Owner's");
      const member = await createMember();
      const created = await body<PlannerCreateTaskResponse>(
        member.asMember("POST", `${API}/tasks`, {
          title: "Member's",
          today: TODAY,
        }),
        201,
      );
      expect(created.task.title).toBe("Member's");

      const theirs = await body<PlannerBoardResponse>(
        member.asMember("GET", `${API}/board?today=${TODAY}`),
      );
      expect(titles(theirs.columns.backlog)).toEqual(["Member's"]);
      expect(titles((await boardOk()).columns.backlog)).toEqual(["Owner's"]);
    });

    it("archives an upstream change when the board loads, with no history read", async () => {
      const task = await createUpstreamTask("Finished in /projects");
      // The first board load archives the creation.
      expect((await boardOk()).history).toBe("ok");

      // Upstream's own route marks it done; the board load alone archives it.
      await body(
        send("PATCH", `/api/app/tasks/${bare(task.id)}`, { status: "done" }),
      );
      await expireSyncDebounce();
      const result = await boardOk();
      expect(titles(result.columns.done)).toEqual(["Finished in /projects"]);

      const archived = await rows<{ type: string; source: string }>(
        "SELECT type, source FROM planner_task_event WHERE task_id = ? AND type = 'status_changed'",
        task.id,
      );
      expect(archived).toEqual([
        { type: "status_changed", source: "activity" },
      ]);
    });

    it("still answers 200 when the history sync fails, and says the archive is paused", async () => {
      await createUpstreamTask("Board still loads");
      // Make the sync's batch fail for real: the snapshot table is renamed away
      // for the duration of the board read. The sync never throws; it records a
      // pause, and the board reads on without it.
      await expireSyncDebounce();
      await withTableRenamedAway("planner_task_seen", async () => {
        const result = await boardOk();
        expect(result.history).toBe("paused");
        expect(titles(result.columns.backlog)).toEqual(["Board still loads"]);
      });
    });
  });

  // ===========================================================================
  // POST /rollover
  // ===========================================================================

  describe("POST /rollover", () => {
    it("carries unfinished plans into the current period, once, and leaves the rest alone", async () => {
      const tomorrow = shiftDay(TODAY, 1);
      const weekStart = plannerPeriodStart("week", tomorrow);
      const monthStart = plannerPeriodStart("month", tomorrow);
      const lastWeek = shiftDay(weekStart, -7);
      const lastMonth = plannerPeriodStart("month", shiftDay(monthStart, -1));

      const dayTask = await createTask("Day plan", {
        plan: { horizon: "day", day: TODAY },
      });
      const weekTask = await createTask("Week plan", {
        plan: { horizon: "week", day: TODAY },
      });
      const monthTask = await createTask("Month plan", {
        plan: { horizon: "month", day: TODAY },
      });
      const doneTask = await createTask("Done plan", {
        plan: { horizon: "day", day: TODAY },
      });
      await patchTaskOk(doneTask.id, { column: "done" });
      const droppedTask = await createTask("Dropped plan", {
        plan: { horizon: "day", day: TODAY },
      });
      await patchTaskOk(droppedTask.id, { dropped: true });
      await createTask("Backlog task");
      // The API will not plan into the past, so age the week and month plans.
      await run(
        "UPDATE planner_task_plan SET period_start = ? WHERE task_id = ?",
        lastWeek,
        weekTask.id,
      );
      await run(
        "UPDATE planner_task_plan SET period_start = ? WHERE task_id = ?",
        lastMonth,
        monthTask.id,
      );

      const first = onTheWire(
        plannerRolloverResponseSchema,
        await body<PlannerRolloverResponse>(
          send("POST", `${API}/rollover`, { today: tomorrow }),
        ),
      );
      expect(first).toEqual({ history: "ok", carried: 3 });

      const moved = await boardOk({ today: tomorrow });
      const byTitle = new Map(
        [...moved.columns.todo, ...moved.columns.done].map((card) => [
          card.title,
          card,
        ]),
      );
      expect(byTitle.get("Day plan")).toMatchObject({
        horizon: "day",
        period_start: tomorrow,
        carry_count: 1,
      });
      expect(byTitle.get("Week plan")).toMatchObject({
        horizon: "week",
        period_start: weekStart,
        carry_count: 1,
      });
      expect(byTitle.get("Month plan")).toMatchObject({
        horizon: "month",
        period_start: monthStart,
        carry_count: 1,
      });
      // Finished work is not carried, and neither is a dropped plan.
      expect(byTitle.get("Done plan")).toMatchObject({
        period_start: TODAY,
        carry_count: 0,
      });
      const withDropped = await boardOk({
        today: tomorrow,
        include_dropped: "true",
      });
      expect(withDropped.columns.dropped?.[0]).toMatchObject({
        title: "Dropped plan",
        period_start: TODAY,
        carry_count: 0,
      });

      // The second call finds nothing left to carry.
      expect(
        await body<PlannerRolloverResponse>(
          send("POST", `${API}/rollover`, { today: tomorrow }),
        ),
      ).toEqual({ history: "ok", carried: 0 });
      expect(
        (await boardOk({ today: tomorrow })).columns.todo.find(
          (card) => card.title === "Day plan",
        )?.carry_count,
      ).toBe(1);

      // Each carry left an event, with the move in it.
      const events = (await history(dayTask.id)).events.filter(
        (event) => event.type === "carried_over",
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        source: "planner",
        actor_type: "user",
        data: {
          from: { horizon: "day", period_start: TODAY },
          to: { horizon: "day", period_start: tomorrow },
        },
      });
    });

    it("syncs the history first, whatever the sync reports", async () => {
      const task = await createUpstreamTask("Made in /projects");
      expect(await count("planner_task_event")).toBe(0);

      expect(
        await body<PlannerRolloverResponse>(
          send("POST", `${API}/rollover`, { today: TODAY }),
        ),
      ).toEqual({ history: "ok", carried: 0 });

      // Upstream's `created` row is now in the archive.
      const archived = await rows<{ type: string; source: string }>(
        "SELECT type, source FROM planner_task_event WHERE task_id = ?",
        task.id,
      );
      expect(archived).toEqual([{ type: "created", source: "activity" }]);
    });
  });

  // ===========================================================================
  // POST /tasks
  // ===========================================================================

  describe("POST /tasks", () => {
    it("creates an unplanned task in the backlog, as upstream would", async () => {
      const response = await send("POST", `${API}/tasks`, {
        title: "  Buy milk  ",
        today: TODAY,
      });
      const created = onTheWire(
        plannerCreateTaskResponseSchema,
        await body<PlannerCreateTaskResponse>(response, 201),
      );

      expect(created.plan).toBeNull();
      expect(created).not.toHaveProperty("plan_error");
      expect(created.task).toMatchObject({
        title: "Buy milk",
        status: "todo",
        priority: "none",
        notes: null,
        due_at: null,
        project_id: null,
      });
      expect(await count("planner_task_plan")).toBe(0);
      expect(await count("planner_task_event")).toBe(0);
      // The task is an ordinary upstream task.
      const upstream = await body<{ task: { title: string } }>(
        send("GET", `/api/app/tasks/${bare(created.task.id)}`),
      );
      expect(upstream.task.title).toBe("Buy milk");
      expect((await boardOk()).columns.backlog[0]?.title).toBe("Buy milk");
    });

    it("passes the upstream fields through and writes the plan with its event", async () => {
      const home = await createProject("Home");
      const created = onTheWire(
        plannerCreateTaskResponseSchema,
        await body<PlannerCreateTaskResponse>(
          send("POST", `${API}/tasks`, {
            title: "Fix the gate",
            notes: "  Oil the hinge ",
            priority: "high",
            due_at: shiftDay(TODAY, 4),
            project_id: home,
            plan: { horizon: "week", day: shiftDay(TODAY, 2) },
            today: TODAY,
          }),
          201,
        ),
      );

      expect(created.task).toMatchObject({
        title: "Fix the gate",
        notes: "Oil the hinge",
        priority: "high",
        due_at: shiftDay(TODAY, 4),
        project_id: home,
      });
      // Any day inside the period names the period.
      expect(created.plan).toMatchObject({
        task_id: created.task.id,
        horizon: "week",
        period_start: plannerPeriodStart("week", shiftDay(TODAY, 2)),
        carry_count: 0,
        dropped_at: null,
      });
      const planned = await rows<{ type: string; data: string }>(
        "SELECT type, data FROM planner_task_event WHERE task_id = ? AND source = 'planner'",
        created.task.id,
      );
      expect(planned.map((event) => event.type)).toEqual(["planned"]);
      expect(JSON.parse(planned[0]?.data ?? "{}")).toEqual({
        from: { horizon: null, period_start: null },
        to: {
          horizon: "week",
          period_start: plannerPeriodStart("week", shiftDay(TODAY, 2)),
        },
      });
    });

    it("treats plan: null like no plan, and accepts a namespaced project id", async () => {
      const home = await createProject("Home");
      const created = await body<PlannerCreateTaskResponse>(
        send("POST", `${API}/tasks`, {
          title: "Unplanned",
          plan: null,
          project_id: home,
          today: TODAY,
        }),
        201,
      );
      expect(created.plan).toBeNull();
      expect(created.task.project_id).toBe(home);
      expect(home).toMatch(/^projects\//);
    });

    it("is a 404 for a project that does not exist or is not the caller's, and creates nothing", async () => {
      const owners = await createProject("Owner's project");
      const member = await createMember();
      await domainError(
        send("POST", `${API}/tasks`, {
          title: "Never",
          project_id: "projects/no-such-project",
          today: TODAY,
        }),
        404,
      );
      await domainError(
        member.asMember("POST", `${API}/tasks`, {
          title: "Never",
          project_id: owners,
          today: TODAY,
        }),
        404,
      );
      expect(await count("tasks")).toBe(0);
    });

    it("keeps the task and reports plan_error when only the plan could not be saved", async () => {
      // Reachable for real: the plan table is gone, the task insert is upstream's.
      await withTableRenamedAway("planner_task_plan", async () => {
        const created = onTheWire(
          plannerCreateTaskResponseSchema,
          await body<PlannerCreateTaskResponse>(
            send("POST", `${API}/tasks`, {
              title: "Kept without its plan",
              plan: { horizon: "day", day: TODAY },
              today: TODAY,
            }),
            201,
          ),
        );

        expect(created.plan).toBeNull();
        expect(created.plan_error).toBe("The plan could not be saved.");
        expect(created.task.title).toBe("Kept without its plan");
        // The task really exists; the failed batch left no event behind.
        expect(await count("tasks")).toBe(1);
        expect(await count("planner_task_event")).toBe(0);
        // The message is safe to show: it names no table and no SQL.
        expect(created.plan_error).not.toMatch(/planner_task_plan|SQL|D1/i);
      });
    });
  });

  // ===========================================================================
  // PATCH /tasks/:id
  // ===========================================================================

  describe("PATCH /tasks/:id", () => {
    it("edits upstream fields through updateTask and still answers with the plan", async () => {
      const home = await createProject("Home");
      const task = await createTask("Before", {
        plan: { horizon: "week", day: TODAY },
      });
      const unplanned = await createTask("Never planned");

      const edited = onTheWire(
        plannerTaskPlanResponseSchema,
        await patchTaskOk(task.id, {
          title: "  After ",
          notes: "Notes",
          priority: "medium",
          due_at: shiftDay(TODAY, 6),
          project_id: home,
        }),
      );
      expect(Object.keys(edited).sort()).toEqual(["plan", "task"]);
      expect(edited.task).toMatchObject({
        title: "After",
        notes: "Notes",
        priority: "medium",
        due_at: shiftDay(TODAY, 6),
        project_id: home,
      });
      // The plan is read back, not lost to the upstream-only edit.
      expect(edited.plan).toMatchObject({
        horizon: "week",
        period_start: plannerPeriodStart("week", TODAY),
      });
      // Clearing fields works through null, as in upstream.
      const cleared = await patchTaskOk(task.id, {
        notes: null,
        due_at: null,
        project_id: null,
      });
      expect(cleared.task).toMatchObject({
        notes: null,
        due_at: null,
        project_id: null,
      });
      // A task that was never planned answers plan: null.
      expect(
        (await patchTaskOk(unplanned.id, { title: "Renamed" })).plan,
      ).toBeNull();

      // It went through upstream's service: one `updated` row per request, and
      // nothing written by the planner.
      const trail = await rows<{ action: string }>(
        "SELECT action FROM task_activity WHERE task_id = ? ORDER BY id",
        task.id,
      );
      expect(trail.map((row) => row.action)).toEqual([
        "created",
        "updated",
        "updated",
      ]);
      expect(await count("planner_task_event")).toBe(1); // only the plan from create
    });

    it("does not touch the task at all for a plan-only or column-only request", async () => {
      const task = await createTask("Quiet");
      const before = await rows(
        "SELECT * FROM task_activity WHERE task_id = ?",
        task.id,
      );

      await patchTaskOk(task.id, { plan: { horizon: "day", day: TODAY } });
      await patchTaskOk(task.id, { plan: null });

      // No empty `updated` row: updateTask is only called when a field is sent.
      expect(
        await rows("SELECT * FROM task_activity WHERE task_id = ?", task.id),
      ).toEqual(before);
    });

    it("plans, replans and unplans, and writes the matching events", async () => {
      const task = await createTask("Moving target");

      const planned = onTheWire(
        plannerTaskPlanResponseSchema,
        await patchTaskOk(task.id, { plan: { horizon: "week", day: TODAY } }),
      );
      expect(planned.plan).toMatchObject({
        horizon: "week",
        period_start: plannerPeriodStart("week", TODAY),
      });
      expect(planned.task.status).toBe("todo");

      const replanned = await patchTaskOk(task.id, {
        plan: { horizon: "day", day: shiftDay(TODAY, 1) },
      });
      expect(replanned.plan).toMatchObject({
        horizon: "day",
        period_start: shiftDay(TODAY, 1),
      });

      // The same plan again changes nothing and writes nothing.
      const eventsBefore = await count("planner_task_event");
      await patchTaskOk(task.id, {
        plan: { horizon: "day", day: shiftDay(TODAY, 1) },
      });
      expect(await count("planner_task_event")).toBe(eventsBefore);

      const unplanned = await patchTaskOk(task.id, { plan: null });
      expect(unplanned.plan).toMatchObject({
        horizon: null,
        period_start: null,
      });
      expect((await boardOk()).columns.backlog.map((card) => card.id)).toEqual([
        task.id,
      ]);

      // The board read above also archives upstream's `created` activity, so only
      // the planner's own events are compared here.
      const types = (
        await rows<{ type: string }>(
          "SELECT type FROM planner_task_event WHERE task_id = ? AND source = 'planner' ORDER BY id",
          task.id,
        )
      ).map((row) => row.type);
      expect(types).toEqual(["planned", "replanned", "unplanned"]);
    });

    it("applies the column move table on the server and answers only task and plan", async () => {
      const task = await createTask("On the move");
      // The To Do marker (v1.2): a To Do task is planned for today, horizon day.
      const marker = TODAY;

      const steps: Array<{
        column: string;
        status: string;
        horizon: string | null;
        periodStart?: string | null;
      }> = [
        // Backlog to To Do: the plan is the To Do marker, for today.
        {
          column: "todo",
          status: "todo",
          horizon: "day",
          periodStart: marker,
        },
        // To Do to Doing: the plan is kept.
        {
          column: "doing",
          status: "in_progress",
          horizon: "day",
          periodStart: marker,
        },
        // Doing to Done: the plan is kept for the record.
        {
          column: "done",
          status: "done",
          horizon: "day",
          periodStart: marker,
        },
        // Done to Doing.
        {
          column: "doing",
          status: "in_progress",
          horizon: "day",
          periodStart: marker,
        },
        // Doing to To Do: the plan is still there.
        {
          column: "todo",
          status: "todo",
          horizon: "day",
          periodStart: marker,
        },
        // To Do to Backlog: the plan is cleared.
        { column: "backlog", status: "todo", horizon: null, periodStart: null },
        // Backlog to Doing: status only; no plan to keep.
        {
          column: "doing",
          status: "in_progress",
          horizon: null,
          periodStart: null,
        },
        // Doing to Backlog.
        { column: "backlog", status: "todo", horizon: null, periodStart: null },
        // Backlog to Done, and Done to To Do, which gets the marker again.
        { column: "done", status: "done", horizon: null, periodStart: null },
        {
          column: "todo",
          status: "todo",
          horizon: "day",
          periodStart: marker,
        },
      ];
      for (const step of steps) {
        const moved = onTheWire(
          plannerTaskPlanResponseSchema,
          await patchTaskOk(task.id, { column: step.column }),
        );
        // `from` and `to` are the domain's, not the wire's.
        expect(Object.keys(moved).sort(), step.column).toEqual([
          "plan",
          "task",
        ]);
        expect(moved.task.status, step.column).toBe(step.status);
        expect(moved.plan?.horizon ?? null, step.column).toBe(step.horizon);
        expect(moved.plan?.period_start ?? null, step.column).toBe(
          step.periodStart ?? null,
        );
        expect(moved.task.completed_at === null, step.column).toBe(
          step.status !== "done",
        );
      }

      // A move to the column it is already in does nothing.
      const before = await count("planner_task_event");
      await patchTaskOk(task.id, { column: "todo" });
      expect(await count("planner_task_event")).toBe(before);
    });

    it("moves a card between the board's columns", async () => {
      const task = await createTask("Dragged");
      const columnOf = async () => {
        const result = await boardOk();
        return plannerColumnSchema.options.filter((column) =>
          result.columns[column].some((card) => card.id === task.id),
        );
      };
      expect(await columnOf()).toEqual(["backlog"]);
      for (const column of ["todo", "doing", "done", "backlog"] as const) {
        await patchTaskOk(task.id, { column });
        expect(await columnOf()).toEqual([column]);
      }
    });

    it("drops a task, keeps its plan, clears its due date and undrops it again", async () => {
      const task = await createTask("Lost cause", {
        plan: { horizon: "week", day: TODAY },
        due_at: shiftDay(TODAY, 5),
      });

      const dropped = onTheWire(
        plannerTaskPlanResponseSchema,
        await patchTaskOk(task.id, { dropped: true }),
      );
      expect(dropped.task.due_at).toBeNull();
      expect(dropped.plan).toMatchObject({
        horizon: "week",
        period_start: plannerPeriodStart("week", TODAY),
      });
      expect(dropped.plan?.dropped_at).toEqual(expect.any(String));
      const board = await boardOk({ include_dropped: "true" });
      expect(titles(board.columns.dropped ?? [])).toEqual(["Lost cause"]);
      expect(titles(board.columns.todo)).toEqual([]);

      // Dropping again is a no-op.
      const again = await patchTaskOk(task.id, { dropped: true });
      expect(again.plan?.dropped_at).toBe(dropped.plan?.dropped_at);

      // Undrop puts it back where its status and kept plan say; the old due
      // date is not restored.
      const back = await patchTaskOk(task.id, { dropped: false });
      expect(back.plan?.dropped_at).toBeNull();
      expect(back.task.due_at).toBeNull();
      expect(titles((await boardOk()).columns.todo)).toEqual(["Lost cause"]);

      const events = await rows<{ type: string; data: string }>(
        "SELECT type, data FROM planner_task_event WHERE task_id = ? AND source = 'planner' ORDER BY id",
        task.id,
      );
      expect(events.map((event) => event.type)).toEqual([
        "planned",
        "dropped",
        "undropped",
      ]);
      expect(JSON.parse(events[1]?.data ?? "{}")).toEqual({
        previous_due_at: shiftDay(TODAY, 5),
      });
    });

    it("applies one request's changes in a fixed order: undrop, upstream fields, column or plan, drop", async () => {
      // Undrop before the move, so a dropped task can be moved in one request.
      const parked = await createTask("Parked", {
        plan: { horizon: "week", day: TODAY },
      });
      await patchTaskOk(parked.id, { dropped: true });
      const revived = await patchTaskOk(parked.id, {
        dropped: false,
        column: "doing",
      });
      expect(revived.task.status).toBe("in_progress");
      expect(revived.plan?.dropped_at).toBeNull();
      const parkedTypes = (
        await rows<{ type: string }>(
          "SELECT type FROM planner_task_event WHERE task_id = ? AND source = 'planner' ORDER BY id",
          parked.id,
        )
      ).map((row) => row.type);
      expect(parkedTypes).toEqual(["planned", "dropped", "undropped"]);

      // Upstream fields first, drop last: the due date set in the same request
      // is what the dropped event remembers, and then it is cleared.
      const doomed = await createTask("Doomed", {
        plan: { horizon: "week", day: TODAY },
      });
      const gone = onTheWire(
        plannerTaskPlanResponseSchema,
        await patchTaskOk(doomed.id, {
          title: "Doomed, renamed",
          due_at: shiftDay(TODAY, 9),
          dropped: true,
        }),
      );
      expect(gone.task).toMatchObject({
        title: "Doomed, renamed",
        due_at: null,
      });
      expect(gone.plan?.dropped_at).toEqual(expect.any(String));
      const droppedEvent = await rows<{ data: string }>(
        "SELECT data FROM planner_task_event WHERE task_id = ? AND type = 'dropped'",
        doomed.id,
      );
      expect(JSON.parse(droppedEvent[0]?.data ?? "{}")).toEqual({
        previous_due_at: shiftDay(TODAY, 9),
      });

      // Upstream fields and a column move together.
      const both = await patchTaskOk((await createTask("Both")).id, {
        title: "Both, done",
        column: "done",
        priority: "low",
      });
      expect(both.task).toMatchObject({
        title: "Both, done",
        status: "done",
        priority: "low",
      });
    });

    it("is not atomic: a step that fails leaves the earlier ones applied", async () => {
      const task = await createTask("Half done", {
        plan: { horizon: "week", day: TODAY },
      });
      await patchTaskOk(task.id, { dropped: true });

      // The title is saved through upstream first; then the move is refused
      // because the task is still dropped.
      await domainError(
        patchTask(task.id, { title: "Renamed anyway", column: "doing" }),
        400,
        "dropped",
      );
      const stored = await body<{ task: { title: string; status: string } }>(
        send("GET", `/api/app/tasks/${bare(task.id)}`),
      );
      expect(stored.task).toMatchObject({
        title: "Renamed anyway",
        status: "todo",
      });
    });

    it("rejects a plan or column move on a dropped task with a clear 400", async () => {
      const task = await createTask("Dropped", {
        plan: { horizon: "week", day: TODAY },
      });
      await patchTaskOk(task.id, { dropped: true });
      await domainError(
        patchTask(task.id, { column: "done" }),
        400,
        "Undrop it first",
      );
      await domainError(
        patchTask(task.id, { plan: { horizon: "day", day: TODAY } }),
        400,
        "Undrop it first",
      );
    });

    it("accepts a bare or a namespaced task id in the path", async () => {
      const task = await createTask("Either way");
      for (const id of [bare(task.id), encodeURIComponent(task.id)]) {
        const response = await send("PATCH", `${API}/tasks/${id}`, {
          today: TODAY,
          title: `Via ${id.length}`,
        });
        expect((await body<PlannerTaskPlanResponse>(response)).task.id).toBe(
          task.id,
        );
      }
    });

    it("is a 404 for a task that is missing, deleted or someone else's, whatever it asks for", async () => {
      const mine = await createTask("Mine", {
        plan: { horizon: "week", day: TODAY },
      });
      const gone = await createTask("Binned");
      await body(send("DELETE", `/api/app/tasks/${bare(gone.id)}`));
      const member = await createMember();

      const changes: Array<Record<string, unknown>> = [
        { title: "Hijacked" },
        { plan: null },
        { plan: { horizon: "day", day: TODAY } },
        { column: "doing" },
        { dropped: true },
        { dropped: false },
        { dropped: true, title: "x" },
      ];
      for (const change of changes) {
        await domainError(
          member.asMember("PATCH", `${API}/tasks/${bare(mine.id)}`, {
            today: TODAY,
            ...change,
          }),
          404,
        );
        // A plain "no such task" looks exactly the same.
        await domainError(patchTask("tasks/no-such-task", change), 404);
        await domainError(patchTask(gone.id, change), 404);
      }

      // The owner's task is untouched by all of it.
      const read = await boardOk({ include_dropped: "true" });
      expect(
        read.columns.todo.find((card) => card.id === mine.id),
      ).toMatchObject({ title: "Mine", dropped_at: null, status: "todo" });
      expect(read.columns.dropped).toEqual([]);
    });
  });

  // ===========================================================================
  // History
  // ===========================================================================

  describe("history", () => {
    it("syncs first, so an edit made through upstream's own routes is already archived", async () => {
      const task = await createUpstreamTask("Edited elsewhere");
      expect(await count("planner_task_event")).toBe(0);

      const first = await history(task.id);
      expect(first.events.map((event) => event.type)).toEqual(["created"]);
      expect(first.events[0]).toMatchObject({
        source: "activity",
        actor_type: "user",
        actor_name: null,
        task_id: task.id,
        task_title: "Edited elsewhere",
      });

      // A later edit through upstream's route shows up once the 30 second
      // debounce has passed.
      await body(
        send("PATCH", `/api/app/tasks/${bare(task.id)}`, { status: "done" }),
      );
      await expireSyncDebounce();
      const second = await history(task.id);
      expect(second.events.map((event) => event.type)).toEqual([
        "status_changed",
        "created",
      ]);
    });

    it("lists planner and upstream events together, newest first, with who did what", async () => {
      const task = await createTask("Busy");
      await patchTaskOk(task.id, { plan: { horizon: "week", day: TODAY } });
      await patchTaskOk(task.id, { column: "doing" });
      await patchTaskOk(task.id, { dropped: true });
      await expireSyncDebounce();

      const { events } = await history(task.id);
      // The events of one request can share a millisecond, so check the set and
      // the ordering rule rather than a fixed sequence for the first two.
      expect(events.map((event) => event.type).sort()).toEqual(
        ["created", "dropped", "planned", "status_changed"].sort(),
      );
      const occurred = events.map((event) => event.occurred_at);
      expect([...occurred].sort().reverse()).toEqual(occurred);
      expect(events[0]?.type).toBe("dropped");
      expect(events.find((event) => event.type === "planned")).toMatchObject({
        source: "planner",
        actor_type: "user",
        data: {
          from: { horizon: null, period_start: null },
          to: { horizon: "week" },
        },
      });
      expect(
        events.find((event) => event.type === "status_changed"),
      ).toMatchObject({
        source: "activity",
        actor_type: "user",
      });
    });

    it("accepts a bare or a namespaced id, and keeps the history of a task that is gone", async () => {
      const task = await createTask("Remembered");
      await patchTaskOk(task.id, { plan: { horizon: "day", day: TODAY } });
      const viaBare = await body<PlannerTaskHistoryResponse>(
        send("GET", `${API}/tasks/${bare(task.id)}/history`),
      );
      const viaNamespaced = await body<PlannerTaskHistoryResponse>(
        send("GET", `${API}/tasks/${encodeURIComponent(task.id)}/history`),
      );
      expect(viaNamespaced).toEqual(viaBare);
      expect(viaBare.events.length).toBeGreaterThan(0);

      // Delete it and let the trash purge it: upstream forgets it, the planner does not.
      await body(send("DELETE", `/api/app/tasks/${bare(task.id)}`));
      await run("DELETE FROM tasks WHERE id = ?", task.id);
      await expireSyncDebounce();
      const after = await history(task.id);
      expect(after.events.map((event) => event.type)).toContain("purged");
      expect(after.events.map((event) => event.type)).toContain("planned");
      expect(
        after.events.every((event) => event.task_title === "Remembered"),
      ).toBe(true);
    });

    it("is an empty list for an unknown task and never shows another user's events", async () => {
      const task = await createTask("Private", {
        plan: { horizon: "week", day: TODAY },
      });
      const member = await createMember();

      expect(
        await body<PlannerTaskHistoryResponse>(
          send("GET", `${API}/tasks/tasks%2Fno-such-task/history`),
        ),
      ).toEqual({ events: [] });
      expect(
        await body<PlannerTaskHistoryResponse>(
          member.asMember("GET", `${API}/tasks/${bare(task.id)}/history`),
        ),
      ).toEqual({ events: [] });
      const theirRange = await body<PlannerHistoryRangeResponse>(
        member.asMember("GET", `${API}/history?from=${TODAY}&to=${TODAY}`),
      );
      expect(theirRange).toEqual({ events: [], truncated: false });
    });

    it("lists the user's events over a range of UTC days", async () => {
      const first = await createTask("First", {
        plan: { horizon: "day", day: TODAY },
      });
      const second = await createUpstreamTask("Second");

      const range = onTheWire(
        plannerHistoryRangeResponseSchema,
        await body<PlannerHistoryRangeResponse>(
          send(
            "GET",
            `${API}/history?from=${shiftDay(TODAY, -1)}&to=${shiftDay(TODAY, 1)}`,
          ),
        ),
      );
      expect(range.truncated).toBe(false);
      const taskIds = new Set(range.events.map((event) => event.task_id));
      expect(taskIds).toEqual(new Set([first.id, second.id]));
      // Both sources are there: the sync ran before the read.
      expect(new Set(range.events.map((event) => event.source))).toEqual(
        new Set(["activity", "planner"]),
      );
      const times = range.events.map((event) => event.occurred_at);
      expect([...times].sort().reverse()).toEqual(times);

      // A range with no events is empty, not an error.
      expect(
        await body<PlannerHistoryRangeResponse>(
          send("GET", `${API}/history?from=2020-01-01&to=2020-01-31`),
        ),
      ).toEqual({ events: [], truncated: false });
      // `from` and `to` may be the same day.
      expect(
        (
          await body<PlannerHistoryRangeResponse>(
            send("GET", `${API}/history?from=${TODAY}&to=${TODAY}`),
          )
        ).events.length,
      ).toBe(range.events.length);
    });

    it("keeps serving when the history sync is paused, and says so", async () => {
      const task = await createTask("Still readable", {
        plan: { horizon: "day", day: TODAY },
      });
      // Break the sync from the inside: its last statement fails, so the whole
      // batch rolls back and the sync records `paused` instead of throwing.
      await withTableRenamedAway("planner_project_node", async () => {
        const read = await body<PlannerTaskHistoryResponse>(
          send("GET", `${API}/tasks/${bare(task.id)}/history`),
        );
        // The planner's own event is archived at write time, so it is still there.
        expect(read.events.map((event) => event.type)).toEqual(["planned"]);
        await expireSyncDebounce();
        expect(
          (
            await body<PlannerHistoryRangeResponse>(
              send("GET", `${API}/history?from=${TODAY}&to=${TODAY}`),
            )
          ).events.length,
        ).toBe(1);

        expect((await boardOk()).history).toBe("paused");
        await expireSyncDebounce();
        const rollover = await body<PlannerRolloverResponse>(
          send("POST", `${API}/rollover`, { today: shiftDay(TODAY, 1) }),
        );
        // Rollover carried on past the paused sync.
        expect(rollover).toEqual({ history: "paused", carried: 1 });
      });
    });
  });

  // ===========================================================================
  // The goal tree
  // ===========================================================================

  describe("goal tree", () => {
    const patchNode = (projectId: string, change: Record<string, unknown>) =>
      send("PATCH", `${API}/tree/${bare(projectId)}`, change);

    const nodeOk = async (projectId: string, change: Record<string, unknown>) =>
      onTheWire(
        plannerTreeNodeResponseSchema,
        await body<PlannerTreeNodeResponse>(patchNode(projectId, change)),
      ).node;

    const tree = async () =>
      onTheWire(
        plannerTreeResponseSchema,
        await body<PlannerTreeResponse>(send("GET", `${API}/tree`)),
      ).nodes;

    it("lists every live project, a root with no level until it is given one", async () => {
      const area = await createProject("Area");
      await createProject("Loose project");

      const nodes = await tree();
      expect(nodes).toHaveLength(2);
      expect(nodes.find((node) => node.id === area)).toEqual({
        id: area,
        name: "Area",
        status: "active",
        parent_project_id: null,
        level: null,
        period_start: null,
        period_end: null,
        sort_order: 0,
      });
    });

    it("nests projects with level, period and order, and merges them into the list", async () => {
      const area = await createProject("Health");
      const goal = await createProject("Run a marathon");
      const milestone = await createProject("Half marathon");

      expect(await nodeOk(area, { level: "area" })).toMatchObject({
        id: area,
        level: "area",
        parent_project_id: null,
      });
      expect(
        await nodeOk(goal, {
          parent_project_id: area,
          level: "goal",
          period_start: "2026-01-01",
          period_end: "2026-12-31",
          sort_order: 2,
        }),
      ).toEqual({
        id: goal,
        name: "Run a marathon",
        status: "active",
        parent_project_id: area,
        level: "goal",
        period_start: "2026-01-01",
        period_end: "2026-12-31",
        sort_order: 2,
      });
      await nodeOk(milestone, {
        parent_project_id: goal,
        level: "milestone",
      });

      const nodes = await tree();
      const parents = Object.fromEntries(
        nodes.map((node) => [node.name, node.parent_project_id]),
      );
      expect(parents).toEqual({
        Health: null,
        "Run a marathon": area,
        "Half marathon": goal,
      });
      // Ordered by sort_order, then creation.
      expect(nodes.map((node) => node.name)).toEqual([
        "Health",
        "Half marathon",
        "Run a marathon",
      ]);
    });

    it("keeps a field you leave out, clears one you send as null, and keeps the children", async () => {
      const area = await createProject("Area");
      const goal = await createProject("Goal");
      const task = await createProject("Task project");
      await nodeOk(goal, {
        parent_project_id: area,
        level: "goal",
        period_start: "2026-01-01",
        period_end: "2026-03-31",
        sort_order: 4,
      });
      await nodeOk(task, { parent_project_id: goal });

      // Only the order changes: parent, level and period stay.
      expect(await nodeOk(goal, { sort_order: 9 })).toMatchObject({
        parent_project_id: area,
        level: "goal",
        period_start: "2026-01-01",
        period_end: "2026-03-31",
        sort_order: 9,
      });
      // Null clears: the level and the period go, the parent stays.
      expect(
        await nodeOk(goal, {
          level: null,
          period_start: null,
          period_end: null,
        }),
      ).toMatchObject({
        parent_project_id: area,
        level: null,
        period_start: null,
        period_end: null,
        sort_order: 9,
      });
      // A null parent makes it a root, and its own child stays under it.
      expect(await nodeOk(goal, { parent_project_id: null })).toMatchObject({
        parent_project_id: null,
      });
      const nodes = await tree();
      expect(nodes.find((node) => node.id === task)?.parent_project_id).toBe(
        goal,
      );
      // Upserting the parent never nulls its children (no INSERT OR REPLACE).
      await nodeOk(goal, { level: "goal" });
      expect(
        (await tree()).find((node) => node.id === task)?.parent_project_id,
      ).toBe(goal);
    });

    it("refuses a cycle with 409, a project as its own parent included", async () => {
      const a = await createProject("A");
      const b = await createProject("B");
      const c = await createProject("C");
      await nodeOk(b, { parent_project_id: a });
      await nodeOk(c, { parent_project_id: b });

      await domainError(
        patchNode(a, { parent_project_id: c }),
        409,
        "ancestor",
      );
      await domainError(patchNode(a, { parent_project_id: b }), 409);
      await domainError(
        patchNode(a, { parent_project_id: a }),
        409,
        "own parent",
      );

      // Nothing moved.
      expect(
        (await tree()).find((node) => node.id === a)?.parent_project_id,
      ).toBeNull();
    });

    it("refuses a tree deeper than six levels with 400", async () => {
      const ids: string[] = [];
      for (let depth = 1; depth <= 7; depth += 1) {
        ids.push(await createProject(`Depth ${depth}`));
      }
      for (let depth = 1; depth < 6; depth += 1) {
        await nodeOk(ids[depth] as string, {
          parent_project_id: ids[depth - 1] as string,
        });
      }
      // The sixth level is allowed; the seventh is not.
      await domainError(
        patchNode(ids[6] as string, { parent_project_id: ids[5] as string }),
        400,
        "6 levels",
      );
    });

    it("accepts a bare or a namespaced project id in the path and the body", async () => {
      const area = await createProject("Area");
      const goal = await createProject("Goal");
      const viaPath = await body<PlannerTreeNodeResponse>(
        send("PATCH", `${API}/tree/${encodeURIComponent(goal)}`, {
          parent_project_id: bare(area),
        }),
      );
      expect(viaPath.node.parent_project_id).toBe(area);
    });

    it("is a 404 for a project that is missing, binned or someone else's, as itself or as a parent", async () => {
      const mine = await createProject("Mine");
      const binned = await createProject("Binned");
      await body(send("DELETE", `/api/app/projects/${bare(binned)}`));
      const member = await createMember();
      const theirs = await body<{ project: { id: string } }>(
        member.asMember("POST", "/api/app/projects", { name: "Theirs" }),
        201,
      );

      await domainError(
        patchNode("projects/no-such-project", { level: "area" }),
        404,
      );
      await domainError(patchNode(binned, { level: "area" }), 404);
      await domainError(patchNode(mine, { parent_project_id: binned }), 404);
      await domainError(
        patchNode(mine, { parent_project_id: "projects/none" }),
        404,
      );
      // Someone else's project, as the target or as the parent.
      await domainError(
        member.asMember("PATCH", `${API}/tree/${bare(mine)}`, {
          level: "area",
        }),
        404,
      );
      await domainError(
        member.asMember("PATCH", `${API}/tree/${bare(theirs.project.id)}`, {
          parent_project_id: mine,
        }),
        404,
      );
      await domainError(
        patchNode(mine, { parent_project_id: theirs.project.id }),
        404,
      );

      // None of it left a node row.
      expect(await count("planner_project_node")).toBe(0);
    });

    it("lists only the caller's live projects", async () => {
      const mine = await createProject("Mine");
      const binned = await createProject("Binned");
      await body(send("DELETE", `/api/app/projects/${bare(binned)}`));
      const member = await createMember();
      await body(
        member.asMember("POST", "/api/app/projects", { name: "Theirs" }),
        201,
      );

      expect((await tree()).map((node) => node.id)).toEqual([mine]);
      const theirs = await body<PlannerTreeResponse>(
        member.asMember("GET", `${API}/tree`),
      );
      expect(theirs.nodes.map((node) => node.name)).toEqual(["Theirs"]);
    });
  });

  // ===========================================================================
  // GET /tree/:projectId/rollup
  // ===========================================================================

  describe("goal tree roll-up", () => {
    it("counts a project and everything beneath it, per node and in total", async () => {
      const area = await createProject("Area");
      const goal = await createProject("Goal");
      const milestone = await createProject("Milestone");
      const sibling = await createProject("Not in the tree");
      await body(send("PATCH", `${API}/tree/${bare(area)}`, { level: "area" }));
      await body(
        send("PATCH", `${API}/tree/${bare(goal)}`, {
          parent_project_id: area,
          level: "goal",
        }),
      );
      await body(
        send("PATCH", `${API}/tree/${bare(milestone)}`, {
          parent_project_id: goal,
          level: "milestone",
        }),
      );

      await createTask("In the area", {
        project_id: area,
        plan: { horizon: "day", day: TODAY },
      });
      const finished = await createTask("In the goal, finished", {
        project_id: goal,
        plan: { horizon: "week", day: TODAY },
      });
      await patchTaskOk(finished.id, { column: "done" });
      await createTask("In the goal, open", { project_id: goal });
      const dropped = await createTask("In the milestone, dropped", {
        project_id: milestone,
        plan: { horizon: "day", day: TODAY },
      });
      await patchTaskOk(dropped.id, { dropped: true });
      await createTask("In the milestone, open", {
        project_id: milestone,
        plan: { horizon: "month", day: TODAY },
      });
      await createTask("Elsewhere", { project_id: sibling });
      await createTask("No project");

      // Wide enough for every plan whatever today is: a month plan starts on the
      // 1st, up to 30 days back, and a week plan on the Monday before today.
      const from = shiftDay(TODAY, -35);
      const to = shiftDay(TODAY, 35);
      const rollup = onTheWire(
        plannerRollupResponseSchema,
        await body<PlannerRollupResponse>(
          send("GET", `${API}/tree/${bare(area)}/rollup?from=${from}&to=${to}`),
        ),
      );

      expect(rollup).toMatchObject({ project_id: area, from, to });
      // Parents before children, with their depth.
      expect(
        rollup.nodes.map((node) => [node.name, node.depth, node.level]),
      ).toEqual([
        ["Area", 0, "area"],
        ["Goal", 1, "goal"],
        ["Milestone", 2, "milestone"],
      ]);
      const counts = (name: string) => {
        const { open_tasks, done_tasks, planned_in_range, done_in_range } =
          rollup.nodes.find((node) => node.name === name) ?? {};
        return { open_tasks, done_tasks, planned_in_range, done_in_range };
      };
      expect(counts("Area")).toEqual({
        open_tasks: 1,
        done_tasks: 0,
        planned_in_range: 1,
        done_in_range: 0,
      });
      expect(counts("Goal")).toEqual({
        open_tasks: 1,
        done_tasks: 1,
        planned_in_range: 1,
        done_in_range: 1,
      });
      // The dropped task is in no count.
      expect(counts("Milestone")).toEqual({
        open_tasks: 1,
        done_tasks: 0,
        planned_in_range: 1,
        done_in_range: 0,
      });
      expect(rollup.total).toMatchObject({
        open_tasks: 3,
        done_tasks: 1,
        planned_in_range: 3,
        done_in_range: 1,
        carried_in_range: 0,
      });
      // Asking from the goal drops the area and what is not beneath it.
      const fromGoal = await body<PlannerRollupResponse>(
        send(
          "GET",
          `${API}/tree/${bare(goal)}/rollup?from=${TODAY}&to=${TODAY}`,
        ),
      );
      expect(fromGoal.nodes.map((node) => node.name)).toEqual([
        "Goal",
        "Milestone",
      ]);
      expect(fromGoal.nodes[0]?.depth).toBe(0);
    });

    it("counts carries in the range", async () => {
      const goal = await createProject("Goal");
      await createTask("Carried", {
        project_id: goal,
        plan: { horizon: "day", day: TODAY },
      });
      await body(
        send("POST", `${API}/rollover`, { today: shiftDay(TODAY, 1) }),
      );

      const rollup = await body<PlannerRollupResponse>(
        send(
          "GET",
          `${API}/tree/${bare(goal)}/rollup?from=${TODAY}&to=${shiftDay(TODAY, 1)}`,
        ),
      );
      expect(rollup.total.carried_in_range).toBe(1);
      expect(rollup.nodes[0]?.carried_in_range).toBe(1);
    });

    it("is a 404 for a project that is missing, binned or someone else's", async () => {
      const mine = await createProject("Mine");
      const binned = await createProject("Binned");
      await body(send("DELETE", `/api/app/projects/${bare(binned)}`));
      const member = await createMember();
      const query = `from=${TODAY}&to=${TODAY}`;

      await domainError(
        send("GET", `${API}/tree/projects%2Fno-such-project/rollup?${query}`),
        404,
      );
      await domainError(
        send("GET", `${API}/tree/${bare(binned)}/rollup?${query}`),
        404,
      );
      await domainError(
        member.asMember("GET", `${API}/tree/${bare(mine)}/rollup?${query}`),
        404,
      );
    });
  });

  // ===========================================================================
  // The task panel: detail, effort, create in a column, comments
  // ===========================================================================

  const detailPath = (id: string) => `${API}/tasks/${bare(id)}`;

  const detailOk = async (id: string) =>
    onTheWire(
      plannerTaskDetailResponseSchema,
      await body<PlannerTaskDetailResponse>(send("GET", detailPath(id))),
    ) as PlannerTaskDetailResponse;

  describe("GET /tasks/:id", () => {
    it("returns the whole task with its plan, effort, goal path and comments", async () => {
      const health = await createProject("Health");
      const marathon = await createProject("Run a marathon");
      await body(
        send("PATCH", `${API}/tree/${bare(marathon)}`, {
          parent_project_id: health,
          level: "goal",
        }),
      );
      const task = await createTask("Train for it", {
        notes: "Long run on Sunday",
        priority: "high",
        due_at: shiftDay(TODAY, 6),
        project_id: marathon,
        plan: { horizon: "week", day: TODAY },
      });
      await patchTaskOk(task.id, { effort: 3.5 });
      const first = await createComment(task.id, "First");
      const second = await createComment(task.id, "Second");

      const detail = await detailOk(task.id);

      expect(detail.task).toMatchObject({
        id: task.id,
        title: "Train for it",
        notes: "Long run on Sunday",
        priority: "high",
        due_at: shiftDay(TODAY, 6),
        project_id: marathon,
        status: "todo",
      });
      expect(detail.plan).toMatchObject({
        task_id: task.id,
        horizon: "week",
        period_start: plannerPeriodStart("week", TODAY),
        carry_count: 0,
        dropped_at: null,
        effort: 3.5,
      });
      expect(detail.project).toEqual({
        id: marathon,
        name: "Run a marathon",
        ancestors: [{ id: health, name: "Health" }],
      });
      expect(detail.comments.map((c) => [c.id, c.body, c.task_id])).toEqual([
        [first.id, "First", task.id],
        [second.id, "Second", task.id],
      ]);
    });

    it("answers a task with nothing else with null plan and project and no comments", async () => {
      const task = await createTask("Plain");
      const detail = await detailOk(task.id);
      expect(Object.keys(detail).sort()).toEqual([
        "comments",
        "plan",
        "project",
        "task",
      ]);
      expect(detail).toMatchObject({ plan: null, project: null, comments: [] });
      expect(detail.task.notes).toBeNull();
    });

    it("gives a project that has no node an empty path", async () => {
      const home = await createProject("Home");
      const task = await createTask("Chore", { project_id: home });
      expect((await detailOk(task.id)).project).toEqual({
        id: home,
        name: "Home",
        ancestors: [],
      });
    });

    it("reads a backlog task that holds only an effort: a plan with no horizon", async () => {
      const task = await createTask("Estimated");
      await patchTaskOk(task.id, { effort: 2 });
      expect((await detailOk(task.id)).plan).toMatchObject({
        horizon: null,
        period_start: null,
        effort: 2,
      });
    });

    it("shows notes the board leaves out, and an edit made through upstream's own route", async () => {
      const task = await createUpstreamTask("Made in /projects", {
        notes: "Written elsewhere",
      });
      expect((await detailOk(task.id)).task.notes).toBe("Written elsewhere");

      await body(
        send("PATCH", `/api/app/tasks/${bare(task.id)}`, {
          title: "Renamed in /projects",
          notes: "Edited elsewhere",
        }),
      );
      expect((await detailOk(task.id)).task).toMatchObject({
        title: "Renamed in /projects",
        notes: "Edited elsewhere",
      });
      // The board card has no notes at all.
      const card = (await boardOk()).columns.backlog.find(
        (entry) => entry.id === task.id,
      );
      expect(card).toBeDefined();
      expect(card).not.toHaveProperty("notes");
    });

    it("accepts a bare or a namespaced task id in the path", async () => {
      const task = await createTask("Either way");
      // The slash of a namespaced id travels percent-encoded, like the web client does.
      for (const id of [bare(task.id), encodeURIComponent(task.id)]) {
        const read = await body<PlannerTaskDetailResponse>(
          send("GET", `${API}/tasks/${id}`),
        );
        expect(read.task.id).toBe(task.id);
      }
    });

    it("is a 404 for a task that is missing, deleted or someone else's, in one envelope", async () => {
      const mine = await createTask("Mine");
      const gone = await createTask("Binned");
      await body(send("DELETE", `/api/app/tasks/${bare(gone.id)}`));
      const member = await createMember();

      await domainError(send("GET", detailPath("tasks/no-such-task")), 404);
      await domainError(send("GET", detailPath(gone.id)), 404);
      await domainError(member.asMember("GET", detailPath(mine.id)), 404);

      // Their own task is theirs to read, and not the owner's.
      const theirs = await body<PlannerCreateTaskResponse>(
        member.asMember("POST", `${API}/tasks`, {
          title: "Member task",
          today: TODAY,
        }),
        201,
      );
      expect(
        (
          await body<PlannerTaskDetailResponse>(
            member.asMember("GET", detailPath(theirs.task.id)),
          )
        ).task.title,
      ).toBe("Member task");
      await domainError(send("GET", detailPath(theirs.task.id)), 404);
    });

    it("is a read: it writes nothing and is not throttled", async () => {
      const task = await createTask("Read twice");
      await createComment(task.id, "Here");
      const counts = async () => [
        await count("planner_task_plan"),
        await count("planner_task_event"),
        await count("planner_task_comment"),
        await count("task_activity"),
      ];
      const before = await counts();
      await detailOk(task.id);
      await detailOk(task.id);
      expect(await counts()).toEqual(before);
    });

    it("works for a personal access token, with no Origin", async () => {
      const task = await createTask("For the agent");
      const token = await createPat();
      const read = await body<PlannerTaskDetailResponse>(
        request("GET", detailPath(task.id), {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(read.task.title).toBe("For the agent");
    });
  });

  describe("PATCH /tasks/:id with effort", () => {
    it("sets, changes and clears the estimate, and answers with the plan that holds it", async () => {
      const task = await createTask("Estimate me");

      const set = onTheWire(
        plannerTaskPlanResponseSchema,
        await patchTaskOk(task.id, { effort: 3 }),
      );
      expect(set.plan).toMatchObject({
        task_id: task.id,
        horizon: null,
        period_start: null,
        effort: 3,
      });
      // It never goes through upstream: the task row and its trail are untouched.
      expect(set.task.updated_at).toBe(task.updated_at);
      expect(
        (
          await rows<{ action: string }>(
            "SELECT action FROM task_activity WHERE task_id = ?",
            task.id,
          )
        ).map((row) => row.action),
      ).toEqual(["created"]);

      expect((await patchTaskOk(task.id, { effort: 5.5 })).plan?.effort).toBe(
        5.5,
      );
      expect((await patchTaskOk(task.id, { effort: 0 })).plan?.effort).toBe(0);
      expect((await patchTaskOk(task.id, { effort: null })).plan?.effort).toBe(
        null,
      );

      // One effort_changed event per change, with {from, to}.
      expect(
        (
          await rows<{ type: string; data: string }>(
            "SELECT type, data FROM planner_task_event WHERE task_id = ? ORDER BY id",
            task.id,
          )
        ).map((row) => [row.type, JSON.parse(row.data)]),
      ).toEqual([
        ["effort_changed", { from: null, to: 3 }],
        ["effort_changed", { from: 3, to: 5.5 }],
        ["effort_changed", { from: 5.5, to: 0 }],
        ["effort_changed", { from: 0, to: null }],
      ]);
    });

    it("leaves the task in Backlog: an estimate is not a plan", async () => {
      const task = await createTask("Still backlog");
      await patchTaskOk(task.id, { effort: 4 });
      const read = await boardOk();
      expect(titles(read.columns.backlog)).toEqual(["Still backlog"]);
      expect(read.columns.todo).toEqual([]);
    });

    it("combines with a title edit, a column move and a plan, applied in the documented order", async () => {
      const task = await createTask("Combined");

      const moved = await patchTaskOk(task.id, {
        title: "Combined and moved",
        column: "doing",
        effort: 2,
      });
      expect(moved.task).toMatchObject({
        title: "Combined and moved",
        status: "in_progress",
      });
      expect(moved.plan?.effort).toBe(2);

      const planned = await patchTaskOk(task.id, {
        plan: { horizon: "week", day: TODAY },
        effort: 4,
      });
      expect(planned.plan).toMatchObject({
        horizon: "week",
        period_start: plannerPeriodStart("week", TODAY),
        effort: 4,
      });
      // Re-planning leaves the estimate; unplanning too.
      expect((await patchTaskOk(task.id, { plan: null })).plan).toMatchObject({
        horizon: null,
        effort: 4,
      });
    });

    it("keeps the estimate through a drop and an undrop, and allows setting it while dropped", async () => {
      const task = await createTask("Dropped with effort");
      await patchTaskOk(task.id, { effort: 6 });
      const dropped = await patchTaskOk(task.id, { dropped: true });
      expect(dropped.plan?.dropped_at).not.toBeNull();
      expect(dropped.plan?.effort).toBe(6);

      const changed = await patchTaskOk(task.id, { effort: 1.5 });
      expect(changed.plan?.effort).toBe(1.5);
      expect(changed.plan?.dropped_at).not.toBeNull();

      const undropped = await patchTaskOk(task.id, { dropped: false });
      expect(undropped.plan).toMatchObject({ dropped_at: null, effort: 1.5 });

      // And one request can undrop, estimate and drop again, in that order.
      const both = await patchTaskOk(task.id, { effort: 9, dropped: true });
      expect(both.plan).toMatchObject({ effort: 9 });
      expect(both.plan?.dropped_at).not.toBeNull();
    });

    it("answers 400 for an estimate out of range, with two decimals or not a number, and changes nothing", async () => {
      const task = await createTask("Strict");
      await patchTaskOk(task.id, { effort: 1 });
      const events = await count("planner_task_event");
      for (const effort of [-1, 1000, 2.25, "3", true, [], {}, 1e9]) {
        expect(
          (await patchTask(task.id, { effort })).status,
          JSON.stringify(effort),
        ).toBe(400);
      }
      expect(
        (
          await rows<{ effort: number }>("SELECT effort FROM planner_task_plan")
        )[0]?.effort,
      ).toBe(1);
      expect(await count("planner_task_event")).toBe(events);
    });

    it("is a 404 for a task that is missing, deleted or someone else's, and writes nothing", async () => {
      const mine = await createTask("Mine");
      const gone = await createTask("Binned");
      await body(send("DELETE", `/api/app/tasks/${bare(gone.id)}`));
      const member = await createMember();

      await domainError(
        member.asMember("PATCH", `${API}/tasks/${bare(mine.id)}`, {
          today: TODAY,
          effort: 3,
        }),
        404,
      );
      await domainError(patchTask("tasks/no-such-task", { effort: 3 }), 404);
      await domainError(patchTask(gone.id, { effort: 3 }), 404);
      expect(await count("planner_task_plan")).toBe(0);
      expect(await count("planner_task_event")).toBe(0);
    });
  });

  describe("PATCH /tasks/:id placing a card in its column", () => {
    const week = () => ({ horizon: "week", day: TODAY });
    const todoTask = (title: string) =>
      createTask(title, { column: "todo", plan: week() });
    const order = async (column: "backlog" | "todo" | "doing" | "done") =>
      titles((await boardOk()).columns[column]);

    it("reorders inside a column, and the order survives a reload", async () => {
      const a = await todoTask("A");
      const b = await todoTask("B");
      const c = await todoTask("C");
      const natural = await order("todo");
      expect(natural).toHaveLength(3);

      const moved = onTheWire(
        plannerTaskPlanResponseSchema,
        await patchTaskOk(c.id, { column: "todo", before_id: a.id }),
      );
      expect(moved.plan?.board_rank).toMatch(/^todo\|/);
      expect(await order("todo")).toEqual(["C", "A", "B"]);

      await patchTaskOk(a.id, { column: "todo", after_id: b.id });
      expect(await order("todo")).toEqual(["C", "B", "A"]);
      // A second read is the same: it is stored, not computed per request.
      expect(await order("todo")).toEqual(["C", "B", "A"]);
      const card = (await boardOk()).columns.todo.find((x) => x.id === b.id);
      expect(card?.board_rank).toEqual(expect.any(String));
    });

    it("moves to another column at a place in it, in one request", async () => {
      const a = await todoTask("A");
      const x = await createTask("X", { column: "doing" });
      const y = await createTask("Y", { column: "doing" });
      await patchTaskOk(y.id, { column: "doing", before_id: x.id });
      expect(await order("doing")).toEqual(["Y", "X"]);

      const moved = await patchTaskOk(a.id, {
        column: "doing",
        after_id: y.id,
      });
      expect(moved.task.status).toBe("in_progress");
      expect(await order("doing")).toEqual(["Y", "A", "X"]);
      expect(await order("todo")).toEqual([]);
    });

    it("writes no history event for the order", async () => {
      const a = await todoTask("A");
      const b = await todoTask("B");
      const plannerEvents = async () =>
        (
          await rows<{ type: string }>(
            "SELECT type FROM planner_task_event WHERE task_id = ? ORDER BY id",
            b.id,
          )
        ).map((row) => row.type);
      expect(await plannerEvents()).toEqual(["planned"]);
      await patchTaskOk(b.id, { column: "todo", before_id: a.id });
      await patchTaskOk(b.id, { column: "todo", after_id: a.id });
      expect(await plannerEvents()).toEqual(["planned"]);
    });

    it("answers 400 for a card that is not in the column, and rolls nothing", async () => {
      const a = await todoTask("A");
      const b = await todoTask("B");
      const doing = await createTask("D", { column: "doing" });
      await domainError(
        patchTask(b.id, { column: "todo", before_id: doing.id }),
        400,
        "not in todo",
      );
      await domainError(
        patchTask(b.id, { column: "todo", before_id: "tasks/nowhere" }),
        400,
        "not in todo",
      );
      expect(await order("todo")).toHaveLength(2);
      void a;
    });

    it("rejects an anchor without a column, and before_id equal to after_id", async () => {
      const a = await todoTask("A");
      const b = await todoTask("B");
      expect((await patchTask(b.id, { before_id: a.id })).status).toBe(400);
      expect(
        (
          await patchTask(b.id, {
            column: "todo",
            before_id: a.id,
            after_id: a.id,
          })
        ).status,
      ).toBe(400);
    });

    it("cannot reorder a dropped task", async () => {
      const a = await todoTask("A");
      const b = await todoTask("B");
      await patchTaskOk(b.id, { dropped: true });
      await domainError(
        patchTask(b.id, { column: "todo", before_id: a.id }),
        400,
        "dropped",
      );
    });

    it("puts a new task on top of a column that has a manual order, and leaves an unranked column alone", async () => {
      const a = await todoTask("A");
      const b = await todoTask("B");
      await patchTaskOk(b.id, { column: "todo", before_id: a.id });
      const created = onTheWire(
        plannerCreateTaskResponseSchema,
        await body<PlannerCreateTaskResponse>(
          send("POST", `${API}/tasks`, {
            title: "New",
            today: TODAY,
            column: "todo",
            plan: week(),
          }),
          201,
        ),
      );
      expect(created.plan?.board_rank).toMatch(/^todo\|/);
      expect(await order("todo")).toEqual(["New", "B", "A"]);

      const backlog = await body<PlannerCreateTaskResponse>(
        send("POST", `${API}/tasks`, {
          title: "Plain",
          today: TODAY,
          column: "backlog",
        }),
        201,
      );
      expect(backlog.plan).toBeNull();
    });
  });

  describe("POST /tasks with a column", () => {
    const createIn = (column: string, extra: Record<string, unknown> = {}) =>
      send("POST", `${API}/tasks`, {
        title: `In ${column}`,
        today: TODAY,
        column,
        ...extra,
      });
    // TODAY is set in beforeEach, so the plan is built when a test asks for it.
    const week = () => ({ horizon: "week", day: TODAY });

    it("creates a Backlog task with no plan", async () => {
      const created = onTheWire(
        plannerCreateTaskResponseSchema,
        await body<PlannerCreateTaskResponse>(createIn("backlog"), 201),
      );
      expect(created.task.status).toBe("todo");
      expect(created.plan).toBeNull();
      expect(titles((await boardOk()).columns.backlog)).toEqual(["In backlog"]);
    });

    it("creates a To Do task with its plan, and refuses one without a plan", async () => {
      const created = await body<PlannerCreateTaskResponse>(
        createIn("todo", { plan: week() }),
        201,
      );
      expect(created.task.status).toBe("todo");
      expect(created.plan).toMatchObject({
        horizon: "week",
        period_start: plannerPeriodStart("week", TODAY),
      });
      expect(titles((await boardOk()).columns.todo)).toEqual(["In todo"]);

      const tasksBefore = await count("tasks");
      await domainError(createIn("todo"), 400, "needs a plan");
      await domainError(createIn("todo", { plan: null }), 400, "needs a plan");
      expect(await count("tasks")).toBe(tasksBefore);
    });

    it("creates a Doing task, with or without a plan", async () => {
      const bareOne = await body<PlannerCreateTaskResponse>(
        createIn("doing"),
        201,
      );
      expect(bareOne.task.status).toBe("in_progress");
      expect(bareOne.plan).toBeNull();

      const planned = await body<PlannerCreateTaskResponse>(
        createIn("doing", { title: "Planned and doing", plan: week() }),
        201,
      );
      expect(planned.task.status).toBe("in_progress");
      expect(planned.plan?.horizon).toBe("week");

      const read = await boardOk();
      expect(titles(read.columns.doing).sort()).toEqual([
        "In doing",
        "Planned and doing",
      ]);
      // One write: a single created row in upstream's trail, no status change.
      expect(
        (
          await rows<{ action: string }>(
            "SELECT action FROM task_activity WHERE task_id = ?",
            bareOne.task.id,
          )
        ).map((row) => row.action),
      ).toEqual(["created"]);
    });

    it("creates a Done task, completed now, with or without a plan", async () => {
      const finished = await body<PlannerCreateTaskResponse>(
        createIn("done"),
        201,
      );
      expect(finished.task.status).toBe("done");
      expect(finished.task.completed_at).not.toBeNull();
      expect(finished.plan).toBeNull();

      const planned = await body<PlannerCreateTaskResponse>(
        createIn("done", {
          title: "Planned and done",
          plan: { horizon: "day", day: TODAY },
        }),
        201,
      );
      expect(planned.plan).toMatchObject({
        horizon: "day",
        period_start: TODAY,
      });

      expect(titles((await boardOk()).columns.done).sort()).toEqual([
        "In done",
        "Planned and done",
      ]);
    });

    it("refuses a plan for a Backlog task and creates nothing", async () => {
      await domainError(
        createIn("backlog", { plan: week() }),
        400,
        "cannot have a plan",
      );
      expect(await count("tasks")).toBe(0);
    });

    it("answers 400 for a column that does not exist, and still works without one", async () => {
      for (const column of ["archive", "Doing", "", "dropped"]) {
        expect((await createIn(column)).status, column).toBe(400);
      }
      expect(
        (
          await send("POST", `${API}/tasks`, {
            title: "x",
            today: TODAY,
            column: null,
          })
        ).status,
      ).toBe(400);
      expect(await count("tasks")).toBe(0);

      const plain = await body<PlannerCreateTaskResponse>(
        send("POST", `${API}/tasks`, { title: "No column", today: TODAY }),
        201,
      );
      expect(plain.task.status).toBe("todo");
    });
  });

  describe("comments", () => {
    const commentsPath = (taskId: string) =>
      `${API}/tasks/${bare(taskId)}/comments`;
    const commentPath = (commentId: string) => `${API}/comments/${commentId}`;

    const listOk = async (taskId: string) =>
      onTheWire(
        plannerCommentListResponseSchema,
        await body<PlannerCommentListResponse>(
          send("GET", commentsPath(taskId)),
        ),
      ).comments as PlannerCommentDto[];

    it("adds a comment, trimmed, answers 201 with exactly the contract, and lists it", async () => {
      const task = await createTask("Discuss");

      const created = onTheWire(
        plannerCommentResponseSchema,
        await body<PlannerCommentResponse>(
          send("POST", commentsPath(task.id), { body: "  Looks good\n" }),
          201,
        ),
      ).comment as PlannerCommentDto;

      expect(created).toEqual({
        id: expect.stringMatching(/^[0-9a-f-]{36}$/),
        task_id: task.id,
        body: "Looks good",
        created_at: expect.any(String),
        updated_at: created.created_at,
      });
      expect(await listOk(task.id)).toEqual([created]);
      // The detail carries the same comment.
      expect((await detailOk(task.id)).comments).toEqual([created]);
    });

    it("lists a task's comments oldest first and leaves out the deleted ones", async () => {
      const task = await createTask("Thread");
      const other = await createTask("Another thread");
      const first = await createComment(task.id, "first");
      const second = await createComment(task.id, "second");
      const third = await createComment(task.id, "third");
      await createComment(other.id, "elsewhere");
      await body(send("DELETE", commentPath(second.id)));

      expect((await listOk(task.id)).map((c) => c.id)).toEqual([
        first.id,
        third.id,
      ]);
      expect((await listOk(other.id)).map((c) => c.body)).toEqual([
        "elsewhere",
      ]);
    });

    it("edits a comment: new text, later update time, the same creation time", async () => {
      const task = await createTask("Edit");
      const comment = await createComment(task.id, "draft");
      await new Promise((resolve) => setTimeout(resolve, 5));

      const edited = onTheWire(
        plannerCommentResponseSchema,
        await body<PlannerCommentResponse>(
          send("PATCH", commentPath(comment.id), { body: "  final " }),
        ),
      ).comment as PlannerCommentDto;

      expect(edited).toMatchObject({
        id: comment.id,
        task_id: task.id,
        body: "final",
        created_at: comment.created_at,
      });
      expect(edited.updated_at > comment.updated_at).toBe(true);
      expect((await listOk(task.id))[0]).toEqual(edited);
    });

    it("deletes a comment softly: gone from the lists, still in the table, answering ok", async () => {
      const task = await createTask("Delete");
      const comment = await createComment(task.id, "to go");

      expect(
        onTheWire(
          plannerDeleteCommentResponseSchema,
          await body(send("DELETE", commentPath(comment.id))),
        ),
      ).toEqual({ ok: true });

      expect(await listOk(task.id)).toEqual([]);
      expect((await detailOk(task.id)).comments).toEqual([]);
      expect(
        await rows<{ body: string; deleted_at: string | null }>(
          "SELECT body, deleted_at FROM planner_task_comment WHERE id = ?",
          comment.id,
        ),
      ).toEqual([{ body: "to go", deleted_at: expect.any(String) }]);
      // A second delete, and an edit of a deleted comment, are 404s.
      await domainError(send("DELETE", commentPath(comment.id)), 404);
      await domainError(
        send("PATCH", commentPath(comment.id), { body: "back" }),
        404,
      );
    });

    it("answers 400 for a blank, missing, too long or mistyped body and for keys it does not know, and writes nothing", async () => {
      const task = await createTask("Strict comments");
      const comment = await createComment(task.id, "keep me");
      const events = await count("planner_task_event");

      const bad: unknown[] = [
        {},
        { body: "" },
        { body: "   \n\t " },
        { body: "x".repeat(plannerCommentBodyMax + 1) },
        { body: 42 },
        { body: null },
        { body: ["a"] },
        { body: "ok", task_id: "tasks/other" },
        { text: "ok" },
      ];
      for (const requestBody of bad) {
        const label = JSON.stringify(requestBody).slice(0, 60);
        expect(
          (await send("POST", commentsPath(task.id), requestBody)).status,
          `POST ${label}`,
        ).toBe(400);
        expect(
          (await send("PATCH", commentPath(comment.id), requestBody)).status,
          `PATCH ${label}`,
        ).toBe(400);
      }
      // The longest body is fine.
      await body(
        send("POST", commentsPath(task.id), {
          body: "y".repeat(plannerCommentBodyMax),
        }),
        201,
      );

      expect((await listOk(task.id)).map((c) => c.body.length)).toEqual([
        7,
        plannerCommentBodyMax,
      ]);
      expect(await count("planner_task_event")).toBe(events + 1);
    });

    it("answers 400 for a malformed JSON body", async () => {
      const task = await createTask("Malformed");
      const comment = await createComment(task.id, "ok");
      for (const [method, path] of [
        ["POST", commentsPath(task.id)],
        ["PATCH", commentPath(comment.id)],
      ] as const) {
        const response = await fetchWorker(
          new Request(url(path), {
            method,
            headers: { ...asOwnerCookie(), "content-type": "application/json" },
            body: "{not json",
          }),
          ctx.env,
        );
        expect(response.status, method).toBe(400);
      }
    });

    it("is a 404 for a task or comment that is missing, deleted or someone else's, whatever the verb", async () => {
      const mine = await createTask("Mine");
      const mineComment = await createComment(mine.id, "mine");
      const gone = await createTask("Binned");
      const goneComment = await createComment(gone.id, "binned");
      await body(send("DELETE", `/api/app/tasks/${bare(gone.id)}`));
      const member = await createMember();
      const theirs = await body<PlannerCreateTaskResponse>(
        member.asMember("POST", `${API}/tasks`, {
          title: "Member task",
          today: TODAY,
        }),
        201,
      );
      const theirComment = await body<PlannerCommentResponse>(
        member.asMember("POST", commentsPath(theirs.task.id), {
          body: "member comment",
        }),
        201,
      );

      // Someone else's task, a binned one, and one that never existed.
      for (const taskId of [theirs.task.id, gone.id, "tasks/no-such-task"]) {
        await domainError(send("GET", commentsPath(taskId)), 404);
        await domainError(
          send("POST", commentsPath(taskId), { body: "hello" }),
          404,
        );
      }
      // Someone else's comment, one on a binned task, and one that never existed.
      for (const commentId of [
        theirComment.comment.id,
        goneComment.id,
        "no-such-comment",
      ]) {
        await domainError(
          send("PATCH", commentPath(commentId), { body: "changed" }),
          404,
        );
        await domainError(send("DELETE", commentPath(commentId)), 404);
      }
      // The member cannot reach the owner's comment either.
      await domainError(
        member.asMember("PATCH", commentPath(mineComment.id), {
          body: "hijacked",
        }),
        404,
      );
      await domainError(
        member.asMember("DELETE", commentPath(mineComment.id)),
        404,
      );

      // Nothing was changed by any of it.
      expect(
        await rows<{ body: string; deleted_at: string | null }>(
          "SELECT body, deleted_at FROM planner_task_comment ORDER BY rowid",
        ),
      ).toEqual([
        { body: "mine", deleted_at: null },
        { body: "binned", deleted_at: null },
        { body: "member comment", deleted_at: null },
      ]);
    });

    it("writes commented, comment_edited and comment_deleted to the history, with the comment's id and never its text", async () => {
      const task = await createTask("History");
      const secret = "the password is hunter2";
      const comment = await createComment(task.id, secret);
      await body(
        send("PATCH", commentPath(comment.id), { body: `${secret}!` }),
      );
      await body(send("DELETE", commentPath(comment.id)));

      const { events } = await history(task.id);

      expect(events.map((event) => event.type)).toEqual([
        "comment_deleted",
        "comment_edited",
        "commented",
        "created",
      ]);
      for (const event of events.filter((e) => e.type.startsWith("comment"))) {
        expect(event).toMatchObject({
          source: "planner",
          actor_type: "user",
          data: { comment_id: comment.id },
        });
      }
      expect(JSON.stringify(events)).not.toContain("hunter2");
    });

    it("lets a personal access token comment as an agent, without an Origin", async () => {
      const task = await createTask("Agent thread");
      const token = await createPat();
      const bearer = { authorization: `Bearer ${token}` };

      const created = await body<PlannerCommentResponse>(
        request("POST", commentsPath(task.id), {
          body: { body: "Posted by a script" },
          headers: bearer,
        }),
        201,
      );
      await body(
        request("PATCH", commentPath(created.comment.id), {
          body: { body: "Posted by a script, edited" },
          headers: bearer,
        }),
      );
      const listed = await body<PlannerCommentListResponse>(
        request("GET", commentsPath(task.id), { headers: bearer }),
      );
      expect(listed.comments.map((c) => c.body)).toEqual([
        "Posted by a script, edited",
      ]);
      await body(
        request("DELETE", commentPath(created.comment.id), { headers: bearer }),
      );

      // Both writes carry an agent in the archive, and an Origin that is not on
      // the allow-list is refused whichever verb it comes with.
      expect(
        (
          await rows<{ type: string; actor_type: string }>(
            "SELECT type, actor_type FROM planner_task_event WHERE task_id = ? AND type LIKE 'comment%' ORDER BY id",
            task.id,
          )
        ).map((row) => [row.type, row.actor_type]),
      ).toEqual([
        ["commented", "agent"],
        ["comment_edited", "agent"],
        ["comment_deleted", "agent"],
      ]);
      for (const [method, path, requestBody] of [
        ["POST", commentsPath(task.id), { body: "Never" }],
        ["PATCH", commentPath("x"), { body: "Never" }],
        ["DELETE", commentPath("x"), undefined],
      ] as const) {
        const response = await request(method, path, {
          body: requestBody,
          headers: { ...bearer, origin: "https://untrusted.example" },
        });
        expect(response.status, `${method} ${path}`).toBe(403);
      }
    });
  });

  // ===========================================================================
  // Rate limiting
  // ===========================================================================

  describe("rate limiting", () => {
    it("throttles every mutation in the planner bucket, per user, before it writes anything", async () => {
      const task = await createTask("Throttled");
      const projectId = await createProject("Throttled project");
      const keys: string[] = [];
      const limitedEnv = {
        ...ctx.env,
        RATE_LIMITER: {
          limit: async (input: { key: string }) => {
            keys.push(input.key);
            return { success: false };
          },
        },
      } as Env;

      const comment = await createComment(task.id, "Throttled comment");
      for (const entry of mutations(task.id, projectId, comment.id)) {
        const response = await request(entry.method, `${API}${entry.path}`, {
          body: entry.body,
          headers: asOwnerCookie(),
          env: limitedEnv,
        });
        expect(response.status, `${entry.method} ${entry.path}`).toBe(429);
        expect(
          ((await response.json()) as { error: { message: string } }).error
            .message,
        ).toContain("Too many requests");
      }
      expect(keys).toEqual(mutations().map(() => `planner:${owner.id}`));
      // Throttled means not done.
      expect(await count("tasks")).toBe(1);
      expect(
        (await rows<{ title: string }>("SELECT title FROM tasks"))[0]?.title,
      ).toBe("Throttled");
      expect(await count("planner_project_node")).toBe(0);
      expect(
        await rows<{ body: string; deleted_at: string | null }>(
          "SELECT body, deleted_at FROM planner_task_comment",
        ),
      ).toEqual([{ body: "Throttled comment", deleted_at: null }]);

      // Reads are not throttled.
      keys.length = 0;
      for (const entry of endpoints(task.id, projectId, comment.id).filter(
        (e) => e.method === "GET",
      )) {
        const response = await request("GET", `${API}${entry.path}`, {
          headers: { cookie: ctx.cookie },
          env: limitedEnv,
        });
        expect(response.status, entry.path).toBe(200);
      }
      expect(keys).toEqual([]);
    });

    it("lets a mutation through when the limiter says yes, and fails open when it errors", async () => {
      const keys: string[] = [];
      const allowing = {
        ...ctx.env,
        RATE_LIMITER: {
          limit: async (input: { key: string }) => {
            keys.push(input.key);
            return { success: true };
          },
        },
      } as Env;
      const broken = {
        ...ctx.env,
        RATE_LIMITER: {
          limit: async () => {
            throw new Error("limiter down");
          },
        },
      } as Env;
      for (const env of [allowing, broken]) {
        const response = await request("POST", `${API}/tasks`, {
          body: { title: "Allowed", today: TODAY },
          headers: asOwnerCookie(),
          env,
        });
        expect(response.status).toBe(201);
      }
      expect(keys).toEqual([`planner:${owner.id}`]);
      expect(await count("tasks")).toBe(2);
    });
  });

  // ===========================================================================
  // Routing
  // ===========================================================================

  describe("routing", () => {
    it("is mounted before /api/app, so nothing there can shadow it", () => {
      const routes = createFlareMoApp().routes;
      const mount = routes.findIndex(
        (route) => route.path === `${API}/*` && route.method === "ALL",
      );
      expect(mount).toBeGreaterThanOrEqual(0);
      // Hono matches in registration order: every route of appApi comes later.
      const appRoutes = appApi.routes.map((route) => `/api/app${route.path}`);
      expect(appRoutes.length).toBeGreaterThan(0);
      const first = routes.findIndex(
        (route) => route.path !== `${API}/*` && appRoutes.includes(route.path),
      );
      expect(first).toBeGreaterThan(mount);
    });

    it("answers /api/app/planner/* from the planner API, not from /api/app", async () => {
      await createTask("Routed");
      const result = await boardOk();
      expect(titles(result.columns.backlog)).toEqual(["Routed"]);

      // An unknown path under the mount is the planner's own JSON 404.
      for (const path of [`${API}/nope`, `${API}/tasks/x/y/z`, `${API}/`]) {
        const response = await send("GET", path);
        expect(response.status, path).toBe(404);
        expect(await response.json()).toEqual({
          error: { message: "Not found" },
        });
      }
      // There is no PUT: the tree uses PATCH, as the CORS allow-list needs.
      const put = await send("PUT", `${API}/tree/projects%2Fnone`, {
        level: "area",
      });
      expect(put.status).toBe(404);
    });

    it("is covered by the API's CORS rules, PATCH and DELETE included", async () => {
      for (const [method, path] of [
        ["PATCH", `${API}/tasks/x`],
        ["PATCH", `${API}/tree/x`],
        ["PATCH", `${API}/comments/x`],
        ["DELETE", `${API}/comments/x`],
        ["POST", `${API}/tasks/x/comments`],
        ["POST", `${API}/rollover`],
        ["GET", `${API}/board`],
        ["GET", `${API}/tasks/x`],
      ] as const) {
        const preflight = await request("OPTIONS", path, {
          headers: {
            origin: ORIGIN,
            "access-control-request-method": method,
            "access-control-request-headers": "content-type",
          },
        });
        expect(preflight.status, `${method} ${path}`).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe(
          ORIGIN,
        );
        expect(preflight.headers.get("access-control-allow-methods")).toContain(
          method,
        );
      }
      // An untrusted origin gets no allow header.
      const refused = await request("OPTIONS", `${API}/tree/x`, {
        headers: {
          origin: "https://untrusted.example",
          "access-control-request-method": "PATCH",
        },
      });
      expect(refused.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  // ===========================================================================
  // Contract consistency
  // ===========================================================================

  describe("the contract", () => {
    it("lists the same columns as the domain, in the same order", () => {
      expect(plannerColumnSchema.options).toEqual([...plannerColumns]);
    });
  });
});
