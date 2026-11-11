import {
  type PlannerMorningResponse,
  plannerMorningDirectionFor,
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

// HTTP tests for the morning page's routes (fork-owned add-on,
// docs/fork-customizations.md "Morning page"): the day's idea line, written
// once and reused, "Another", a refusal, and "Start the day". Through the real
// Worker entry with the owner's cookie session; Claude's Messages API is
// replaced.

const API = "/api/app/planner";

type Context = {
  runtime: Miniflare;
  d1: D1Database;
  env: Env;
  cookie: string;
  current: Env;
};

describe("planner morning API", () => {
  let ctx: Context;
  let TODAY: string;

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
      name: "flaremo-planner-morning",
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
    await ctx.d1.batch([
      ctx.d1.prepare("DELETE FROM planner_morning_line"),
      ctx.d1.prepare("DELETE FROM planner_morning_day"),
    ]);
    TODAY = new Date().toISOString().slice(0, 10);
    ctx.current = ctx.env;
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
  async function read(response: Promise<Response>, status = 200) {
    const answer = await response;
    expect(answer.status).toBe(status);
    return (await answer.json()) as PlannerMorningResponse;
  }

  /** Replaces Claude: each call answers the next of `answers`. */
  function fakeClaude(
    answers: Array<{ text?: string; stop_reason?: string }>,
  ): Array<{
    model: string;
    system: string;
    messages: Array<{ content: string }>;
    output_config?: { effort?: string };
  }> {
    const realFetch = globalThis.fetch;
    const sent: ReturnType<typeof fakeClaude> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const target = input instanceof Request ? input.url : String(input);
      if (!target.startsWith("https://api.anthropic.com/")) {
        return realFetch(input, init);
      }
      sent.push(JSON.parse(String(init?.body)));
      const answer = answers[sent.length - 1] ?? {};
      return Response.json({
        stop_reason: answer.stop_reason ?? "end_turn",
        content: answer.text ? [{ type: "text", text: answer.text }] : [],
        usage: { input_tokens: 9000, output_tokens: 400 },
      });
    });
    ctx.current = {
      ...ctx.env,
      ANTHROPIC_API_KEY: "test-anthropic-key",
    } as unknown as Env;
    return sent;
  }

  it("has no line and hides the slot without a key", async () => {
    const first = await read(send("GET", `/morning?today=${TODAY}`));
    expect(first).toEqual({
      day: TODAY,
      dismissed: false,
      line: null,
      can_write: false,
    });
    const written = await read(send("POST", "/morning/line", { today: TODAY }));
    expect(written.line).toBeNull();
    // A day far from the server's is refused.
    expect((await send("GET", "/morning?today=2001-01-01")).status).toBe(400);
  });

  it("writes the day's line once with Opus at medium effort, and Another replaces it", async () => {
    const sent = fakeClaude([
      { text: '"Text Sam the photo from Saturday."' },
      { text: "Cook the soup your grandmother used to make." },
    ]);
    const first = await read(send("POST", "/morning/line", { today: TODAY }));
    expect(first.can_write).toBe(true);
    expect(first.line).toMatchObject({
      text: "Text Sam the photo from Saturday.",
      direction: plannerMorningDirectionFor(TODAY),
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.model).toBe("claude-opus-5-5");
    expect(sent[0]?.output_config?.effort).toBe("medium");
    expect(sent[0]?.system).toContain("You write the one line at the top");
    expect(sent[0]?.system).toContain(
      plannerMorningDirectionFor(TODAY) === "away"
        ? "something off-plan"
        : "your call",
    );
    expect(sent[0]?.messages[0]?.content).toContain("- none yet");

    // A reload gets the same line without a second call.
    const again = await read(send("POST", "/morning/line", { today: TODAY }));
    expect(again.line?.id).toBe(first.line?.id);
    expect(sent).toHaveLength(1);

    // Another: a new line, and the old one is fed back as "do not repeat".
    const another = await read(
      send("POST", "/morning/line", {
        today: TODAY,
        replace: first.line?.id,
      }),
    );
    expect(another.line?.text).toBe(
      "Cook the soup your grandmother used to make.",
    );
    expect(sent[1]?.messages[0]?.content).toContain(
      "- Text Sam the photo from Saturday.",
    );
    const rows = await ctx.d1
      .prepare(
        "SELECT text, replaced_by, shown, input_tokens FROM planner_morning_line ORDER BY created_at",
      )
      .all<{
        text: string;
        replaced_by: string | null;
        shown: number;
        input_tokens: number;
      }>();
    expect(rows.results).toEqual([
      {
        text: "Text Sam the photo from Saturday.",
        replaced_by: another.line?.id,
        shown: 1,
        input_tokens: 9000,
      },
      {
        text: "Cook the soup your grandmother used to make.",
        replaced_by: null,
        shown: 1,
        input_tokens: 9000,
      },
    ]);
  });

  it("shows no line when the model declines, and keeps the old one on a failed Another", async () => {
    fakeClaude([{ stop_reason: "refusal" }]);
    const declined = await read(
      send("POST", "/morning/line", { today: TODAY }),
    );
    expect(declined.line).toBeNull();

    vi.restoreAllMocks();
    fakeClaude([{ text: "Walk the long way home." }, { text: "" }]);
    const kept = await read(send("POST", "/morning/line", { today: TODAY }));
    const failed = await read(
      send("POST", "/morning/line", { today: TODAY, replace: kept.line?.id }),
    );
    expect(failed.line).toEqual(kept.line);
  });

  it("Start the day dismisses the page for the day and marks the line kept", async () => {
    fakeClaude([{ text: "Walk the long way home." }]);
    const written = await read(send("POST", "/morning/line", { today: TODAY }));
    const dismissed = await read(
      send("POST", "/morning/dismiss", {
        today: TODAY,
        line_id: written.line?.id,
      }),
    );
    expect(dismissed.dismissed).toBe(true);
    expect((await read(send("GET", `/morning?today=${TODAY}`))).dismissed).toBe(
      true,
    );
    const chosen = await ctx.d1
      .prepare("SELECT chosen FROM planner_morning_line")
      .first<{ chosen: number }>();
    expect(chosen?.chosen).toBe(1);
    // Pressing it twice is fine.
    expect(
      (await send("POST", "/morning/dismiss", { today: TODAY })).status,
    ).toBe(200);
  });
});
