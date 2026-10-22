import { defaultKeyHasher } from "@better-auth/api-key";
import {
  type PlannerBoardResponse,
  type PlannerCreateTaskResponse,
  type PlannerTaskDetailResponse,
  type PlannerTaskHistoryResponse,
  plannerBoardResponseSchema,
  plannerTaskDetailResponseSchema,
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
import { createAppTestHarness } from "../test-support/app";
import { createTestRuntime, fetchWorker } from "../test-support/runtime";
import { bootstrapAndSignIn } from "../test-support/sign-in";

// The cockpit's task tools on the app's /mcp server (fork/task-mcp-tools.ts),
// driven through the real Worker with a real personal access token, as an MCP
// client would. "Today" is the real UTC date, as in planner-api.test.ts.

const ORIGIN = "http://flaremo.test";
const RESET_TABLES = [
  "planner_task_event",
  "planner_task_plan",
  "planner_task_seen",
  "planner_sync_state",
  "planner_task_comment",
  "task_activity",
  "tasks",
] as const;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent: unknown;
};

describe("cockpit task tools on /mcp", () => {
  let runtime: Miniflare;
  let d1: D1Database;
  let env: Env;
  let cookie: string;
  let token: string;
  let id = 0;

  const harness = createAppTestHarness(() => ({ env, sessionCookie: cookie }));

  beforeAll(async () => {
    const created = await createTestRuntime({
      name: "flaremo-task-mcp",
      env: { FLAREMO_EMBEDDING_PROVIDER: "none" },
    });
    runtime = created.runtime;
    d1 = created.db;
    env = created.env;
    await applyPlannerMigrations(d1);
    cookie = await bootstrapAndSignIn(env);
    const pat = await fetchWorker(
      new Request(`${ORIGIN}/api/app/account/personal-access-tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, origin: ORIGIN },
        body: JSON.stringify({ name: "mcp-test", expires_in_days: 30 }),
      }),
      env,
    );
    expect(pat.status).toBe(201);
    token = ((await pat.json()) as { token: string }).token;
  });

  afterAll(async () => {
    await runtime.dispose();
  });

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await d1.batch(
      RESET_TABLES.map((table) => d1.prepare(`DELETE FROM ${table}`)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function rpc(body: unknown, authorization = `Bearer ${token}`) {
    return fetchWorker(
      new Request(`${ORIGIN}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization },
        body: JSON.stringify(body),
      }),
      env,
    );
  }

  async function call(name: string, args: Record<string, unknown> = {}) {
    const response = await rpc({
      jsonrpc: "2.0",
      id: ++id,
      method: "tools/call",
      params: { name, arguments: args },
    });
    expect(response.status).toBe(200);
    return ((await response.json()) as { result: ToolResult }).result;
  }

  async function ok<T>(name: string, args: Record<string, unknown> = {}) {
    const result = await call(name, args);
    expect(result.isError, result.content[0]?.text).toBeFalsy();
    return result.structuredContent as T;
  }

  it("lists the task tools to a token", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const body = (await response.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "task_read_board",
        "task_get_task",
        "task_get_history",
        "task_create_task",
        "task_update_task",
        "task_add_comment",
      ]),
    );
  });

  it("creates, moves, comments on and reads back a task, with the token named in history", async () => {
    const created = await ok<PlannerCreateTaskResponse>("task_create_task", {
      title: "Write the MCP tools",
      priority: "high",
    });
    const taskId = created.task.id;

    let board = plannerBoardResponseSchema.parse(
      await ok<PlannerBoardResponse>("task_read_board"),
    );
    expect(board.columns.backlog.map((card) => card.id)).toEqual([taskId]);

    await ok("task_update_task", { id: taskId, column: "doing", effort: 2.5 });
    await ok("task_add_comment", { id: taskId, body: "Started on it." });

    board = plannerBoardResponseSchema.parse(
      await ok<PlannerBoardResponse>("task_read_board"),
    );
    expect(board.columns.backlog).toEqual([]);
    expect(board.columns.doing.map((card) => card.id)).toEqual([taskId]);

    const detail = plannerTaskDetailResponseSchema.parse(
      await ok<PlannerTaskDetailResponse>("task_get_task", { id: taskId }),
    );
    expect(detail.plan?.effort).toBe(2.5);
    expect(detail.comments.map((comment) => comment.body)).toEqual([
      "Started on it.",
    ]);

    const history = await ok<PlannerTaskHistoryResponse>("task_get_history", {
      id: taskId,
    });
    const label = `pat:${(await defaultKeyHasher(token)).slice(0, 8)}`;
    expect(history.events.length).toBeGreaterThanOrEqual(3);
    for (const event of history.events.filter((e) => e.actor_type)) {
      expect(event).toMatchObject({ actor_type: "agent", actor_name: label });
    }

    // The cockpit's own REST board sees the same task (cookie session).
    const rest = await harness.fetchApp(
      `${ORIGIN}/api/app/planner/board?today=${board.today}`,
    );
    const restBoard = (await rest.json()) as PlannerBoardResponse;
    expect(restBoard.columns.doing.map((card) => card.id)).toEqual([taskId]);
  });

  it("drops a task softly: it leaves the board but the row and its history stay", async () => {
    const { task } = await ok<PlannerCreateTaskResponse>("task_create_task", {
      title: "Maybe later",
    });
    await ok("task_update_task", { id: task.id, dropped: true });

    const board = await ok<PlannerBoardResponse>("task_read_board", {
      include_dropped: true,
    });
    expect(board.columns.backlog).toEqual([]);
    expect(board.columns.dropped?.map((card) => card.id)).toEqual([task.id]);
    const rows = await d1
      .prepare("SELECT COUNT(*) AS n FROM tasks")
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("returns bad input as a tool error and writes nothing", async () => {
    const { task } = await ok<PlannerCreateTaskResponse>("task_create_task", {
      title: "Stays put",
    });
    const before = await d1
      .prepare("SELECT COUNT(*) AS n FROM planner_task_event")
      .first<{ n: number }>();

    const both = await call("task_update_task", {
      id: task.id,
      column: "todo",
      plan: { horizon: "week", day: "2026-01-05" },
    });
    expect(both.isError).toBe(true);

    const farDay = await call("task_create_task", {
      title: "x",
      today: "2001-01-01",
    });
    expect(farDay).toMatchObject({ isError: true });
    expect(farDay.content[0]?.text).toContain("today");

    const missing = await call("task_get_task", { id: "tasks/nope" });
    expect(missing.isError).toBe(true);

    const noTitle = await call("task_create_task", {});
    expect(noTitle.isError).toBe(true);

    const after = await d1
      .prepare("SELECT COUNT(*) AS n FROM planner_task_event")
      .first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
    expect(
      (
        await d1
          .prepare("SELECT COUNT(*) AS n FROM tasks")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });

  it("refuses a call without a valid token", async () => {
    const response = await rpc(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "task_read_board" },
      },
      "Bearer memos_pat_not_a_real_token",
    );
    expect(response.status).toBe(401);
  });
});
