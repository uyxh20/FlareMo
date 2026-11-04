import {
  type PlannerFlywheelResponse,
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
import { createAppTestHarness } from "../test-support/app";
import { createTestRuntime } from "../test-support/runtime";
import { bootstrapAndSignIn } from "../test-support/sign-in";

// HTTP tests for the flywheel's routes (fork-owned add-on,
// docs/fork-flywheel.md): the Sunday review's scorecard card, the weekly note
// to the agent, and a tuning proposal from the owner or the model, accepted
// with edits. Through the real Worker entry with the owner's cookie session;
// Claude's Messages API is replaced.

const API = "/api/app/planner";
const RESET_TABLES = [
  "planner_event",
  "planner_metric_week",
  "planner_tuning",
  "planner_week",
  "planner_agent_action",
] as const;

type Context = {
  runtime: Miniflare;
  d1: D1Database;
  env: Env;
  cookie: string;
  current: Env;
};

describe("planner flywheel API", () => {
  let ctx: Context;
  let TODAY: string;
  let WEEK: string;

  const harness = createAppTestHarness(() => ({
    env: ctx.current,
    sessionCookie: ctx.cookie,
  }));

  beforeAll(async () => {
    const {
      runtime,
      db: d1,
      env,
    } = await createTestRuntime({
      name: "flaremo-planner-flywheel",
      env: { FLAREMO_EMBEDDING_PROVIDER: "none" },
    });
    await applyPlannerMigrations(d1);
    ctx = {
      runtime,
      d1,
      env,
      cookie: await bootstrapAndSignIn(env),
      current: env,
    };
  });

  afterAll(async () => {
    await ctx.runtime.dispose();
  });

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await ctx.d1.batch(
      RESET_TABLES.map((table) => ctx.d1.prepare(`DELETE FROM ${table}`)),
    );
    TODAY = new Date().toISOString().slice(0, 10);
    WEEK = plannerWeekStartOf(TODAY);
    ctx.current = {
      ...ctx.env,
      FLAREMO_REVIEW_AI: "off",
    } as unknown as Env;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const url = (path: string) => `http://flaremo.test${API}${path}`;
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
  async function card(response: Promise<Response>, status = 200) {
    const answer = await response;
    expect(answer.status).toBe(status);
    return (await answer.json()) as PlannerFlywheelResponse;
  }

  it("reads the week's card, building its scorecard first", async () => {
    const read = await card(
      send("GET", `/flywheel/${WEEK}?${new URLSearchParams({ today: TODAY })}`),
    );
    expect(read.week_start).toBe(WEEK);
    expect(read.weeks[0]?.week_start).toBe(WEEK);
    expect(read.weeks[0]?.values.length).toBeGreaterThan(10);
    expect(read).toMatchObject({
      current: null,
      proposal: null,
      verdict: null,
      proposal_due: true,
      note: null,
      note_skipped: false,
      last_viewed_days: null,
      proposing_paused: false,
      can_propose: false,
    });
    // A Tuesday is not a week.
    const tuesday = (await send("GET", `/flywheel/2026-10-20?today=${TODAY}`))
      .status;
    expect(tuesday).toBe(400);
  });

  it("saves the note, and files and accepts the owner's own version", async () => {
    const noted = await card(
      send("POST", `/flywheel/${WEEK}/note`, { note: "Ask fewer questions." }),
    );
    expect(noted.note).toBe("Ask fewer questions.");
    const proposed = await card(
      send("POST", `/flywheel/${WEEK}/tuning/propose`, {
        today: TODAY,
        instructions: "Ask at most one question a turn.",
      }),
    );
    expect(proposed.proposal).toMatchObject({
      proposed_by: "owner",
      state: "proposed",
    });
    const accepted = await card(
      send("POST", `/flywheel/${WEEK}/tuning/${proposed.proposal?.id}`, {
        decision: "accept",
        instructions: "Ask at most one question a turn. Be brief.",
      }),
    );
    expect(accepted.proposal).toBeNull();
    expect(accepted.current).toMatchObject({
      version: 1,
      state: "active",
      instructions: "Ask at most one question a turn. Be brief.",
    });
    // Settled once only.
    const again = await send(
      "POST",
      `/flywheel/${WEEK}/tuning/${proposed.proposal?.id}`,
      { decision: "dismiss" },
    );
    expect(again.status).toBe(400);
  });

  it("asks the model for a proposal, and says so when there is no model", async () => {
    const none = await send("POST", `/flywheel/${WEEK}/tuning/propose`, {
      today: TODAY,
    });
    expect(none.status).toBe(503);

    const realFetch = globalThis.fetch;
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const target = input instanceof Request ? input.url : String(input);
      if (!target.startsWith("https://api.anthropic.com/")) {
        return realFetch(input, init);
      }
      sent.push(String(init?.body));
      return Response.json({
        content: [
          {
            type: "text",
            text: '{"instructions":"Propose fewer errands.","why":"Errands were dismissed.","metric":"proposals_accepted"}',
          },
        ],
      });
    });
    ctx.current = {
      ...ctx.env,
      ANTHROPIC_API_KEY: "test-anthropic-key",
    } as unknown as Env;
    await send("POST", `/flywheel/${WEEK}/note`, { note: "Too many errands." });
    const proposed = await card(
      send("POST", `/flywheel/${WEEK}/tuning/propose`, { today: TODAY }),
    );
    expect(proposed.can_propose).toBe(true);
    expect(proposed.proposal).toMatchObject({
      proposed_by: "agent",
      instructions: "Propose fewer errands.",
      metric: "proposals_accepted",
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("Too many errands.");
    const dismissed = await card(
      send("POST", `/flywheel/${WEEK}/tuning/${proposed.proposal?.id}`, {
        decision: "dismiss",
      }),
    );
    expect(dismissed.proposal).toBeNull();
    expect(dismissed.current).toBeNull();
  });
});
