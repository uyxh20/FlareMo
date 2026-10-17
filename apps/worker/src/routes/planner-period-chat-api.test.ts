import {
  type PlannerPeriodReviewResponse,
  plannerAddDays,
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
import { createTestRuntime, fetchWorker } from "../test-support/runtime";
import { bootstrapAndSignIn } from "../test-support/sign-in";

// HTTP tests for the month and quarter chat (planner-period-review-api.ts,
// /period-review/:level/:period/chat/ai/*): the weekly review's AI requests
// over a period, with What happened kept only where the owner's own words
// back it. The model is a fake Workers AI binding: nothing leaves the test.

const ORIGIN = "http://flaremo.test";
const API = "/api/app/planner";

const utcDay = () => new Date().toISOString().slice(0, 10);

function fakeAi(options: { answer?: string; pieces?: string[] }) {
  return {
    async run(_model: string, inputs: Record<string, unknown>) {
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

async function lines(
  response: Response,
): Promise<Array<Record<string, unknown>>> {
  const text = await response.text();
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("the month and quarter chat API", () => {
  let runtime: Miniflare;
  let d1: D1Database;
  let env: Env;
  let cookie: string;
  let TODAY: string;
  let period: PlannerPeriodReviewResponse;

  beforeAll(async () => {
    const created = await createTestRuntime({
      name: "flaremo-planner-period-chat-api",
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

  const call = (method: string, path: string, body?: unknown, use = env) =>
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
      use,
    );
  const withAi = (ai: ReturnType<typeof fakeAi>) =>
    ({ ...env, AI: ai }) as unknown as Env;
  const chat = (rest: string) =>
    `/period-review/month/${period.period_start}/chat/ai/${rest}`;

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    TODAY = utcDay();
    await d1.prepare("DELETE FROM memos").run();
    const response = await call(
      "GET",
      `/period-review?today=${TODAY}&level=month`,
    );
    expect(response.status).toBe(200);
    period = (await response.json()) as PlannerPeriodReviewResponse;
    // One diary entry in the middle of the period's second week.
    const monday = period.weeks[1]?.week_start ?? period.period_start;
    const at = `${plannerAddDays(monday, 2)}T12:00:00.000Z`;
    await d1
      .prepare(
        "INSERT INTO memos (id, user_id, content, visibility, created_at, updated_at) VALUES ('entry-1', 'users/owner', ?, 'private', ?, ?)",
      )
      .bind(
        "Shipped the exporter on Tuesday, late night, and slept badly.",
        at,
        at,
      )
      .run();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers 503 with no model, as the weekly routes do", async () => {
    const response = await call("POST", chat("opening"), { today: TODAY });
    expect(response.status).toBe(503);
  });

  it("keeps only the claims the owner's words back", async () => {
    const answer = JSON.stringify({
      happened: [
        {
          claim: "The exporter shipped.",
          quote: "Shipped the exporter on Tuesday, late night",
          pillar: "work",
        },
        {
          claim: "Felt focused.",
          quote: "I felt far more focused than ever before",
          pillar: "of",
        },
      ],
      recap: "A shipping month.",
      prompts: [["Shipped it", "Not sure"]],
    });
    const response = await call(
      "POST",
      chat("opening"),
      { today: TODAY },
      withAi(fakeAi({ answer })),
    );
    expect(response.status).toBe(200);
    const opening = (await response.json()) as Record<string, unknown>;
    expect(opening.recap).toBe("A shipping month.");
    expect(opening.dropped).toBe(1);
    expect(opening.happened).toEqual([
      expect.objectContaining({
        claim: "The exporter shipped.",
        source: "memo",
        source_id: "entry-1",
      }),
    ]);
  });

  it("streams the coach and the memo in the weekly review's lines", async () => {
    const coach = await lines(
      await call(
        "POST",
        chat("coach"),
        {
          today: TODAY,
          mode: "free",
          messages: [{ role: "user", content: "Shipped it." }],
        },
        withAi(fakeAi({ pieces: ["Which day? ", '@@ {"advance": false}'] })),
      ),
    );
    expect(coach.at(-1)).toEqual({ done: true, advance: false });
    const memo = await lines(
      await call(
        "POST",
        chat("memo"),
        {
          today: TODAY,
          last_answer: [],
          answers: [[], [], [], [], [], [], []],
          goal_results: [],
          coach_notes: [],
          scores: { auth: 4, ach: 3.5 },
          question: null,
          verdict: null,
          recommended: "continue",
          drafts: {
            auth_evidence: "",
            ach_evidence: "",
            pattern: "",
            risk: "",
            opportunity: "",
          },
          happened: [],
        },
        withAi(fakeAi({ pieces: ["Sure!\n", "# Month review: x\n", "Body"] })),
      ),
    );
    const text = memo
      .filter((line) => typeof line.d === "string")
      .map((line) => line.d)
      .join("");
    expect(text).toBe("# Month review: x\nBody");
    expect(memo.at(-1)).toEqual({ done: true });
  });
});
