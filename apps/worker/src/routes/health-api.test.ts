import {
  type HealthEntryResponse,
  type HealthGoalProgressResponse,
  type HealthMemosResponse,
  type HealthRescanResponse,
  type HealthTargetsResponse,
  type HealthTrackerPreviewResponse,
  type HealthTrackerSaveResponse,
  type HealthTrackersResponse,
  type HealthWeekResponse,
  type HealthYearResponse,
  healthEntryResponseSchema,
  healthGoalProgressResponseSchema,
  healthMemosResponseSchema,
  healthRescanResponseSchema,
  healthTargetsResponseSchema,
  healthTrackerPreviewResponseSchema,
  healthTrackerSaveResponseSchema,
  healthTrackersResponseSchema,
  healthWeekResponseSchema,
  healthYearResponseSchema,
} from "@flaremo/contracts";
import { applyPlannerMigrations } from "@flaremo/db/src/planner-migrations";
import { healthToday } from "@flaremo/domain/src/health";
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

// HTTP tests for the health tracker API (fork-owned add-on,
// docs/fork-health-tracker.md). Every request goes through the real Worker
// entry with real auth: the owner's cookie session, a personal access token, and
// no credentials at all. The planner migrations (which include 9010) are applied
// on top of upstream's. Memos are written through the real memo route, so the
// hook that reads them is exercised end to end.

const ORIGIN = "http://flaremo.test";
const API = "/api/app/health-tracker";

const FASTING = {
  label: "Fasting",
  color: "green",
  measure: "hours",
  words: ["#fast", "Fasted"],
  blocked: [],
  goal_id: null,
};

const RESET_TABLES = [
  "health_tracker_event",
  "health_tracker",
  "health_entry_event",
  "health_entry",
  "health_target",
  "health_sync_state",
  "memos",
] as const;

type Context = {
  runtime: Miniflare;
  d1: D1Database;
  env: Env;
  cookie: string;
};

describe("health API", () => {
  let ctx: Context;

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
      name: "flaremo-health-api",
      env: {
        FLAREMO_EMBEDDING_PROVIDER: "none",
        FLAREMO_DEPLOY_REPOSITORY: "",
      },
    });
    await applyPlannerMigrations(d1);
    ctx = { runtime, d1, env, cookie: await bootstrapAndSignIn(env) };
  });

  afterAll(async () => {
    await ctx.runtime.dispose();
  });

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    await ctx.d1.batch(
      RESET_TABLES.map((table) => ctx.d1.prepare(`DELETE FROM ${table}`)),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  /** A request with exactly the headers given. */
  const request = (
    method: string,
    path: string,
    options: { body?: unknown; headers?: Record<string, string> } = {},
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
      ctx.env,
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

  /** Parses a body with its schema and checks nothing was lost or added. */
  function onTheWire<T extends z.ZodType>(
    schema: T,
    value: unknown,
  ): z.infer<T> {
    const parsed = schema.parse(value);
    expect(parsed).toEqual(value);
    return parsed;
  }

  async function writeMemo(content: string) {
    return body<{ name: string; id: string }>(
      send("POST", "/api/app/memos", { content, visibility: "private" }),
      201,
    );
  }

  const week = async (query = "") =>
    onTheWire(
      healthWeekResponseSchema,
      await body<HealthWeekResponse>(send("GET", `${API}/week${query}`)),
    ) as HealthWeekResponse;

  async function rows<T = Record<string, unknown>>(
    sql: string,
    ...params: unknown[]
  ) {
    return (
      await ctx.d1
        .prepare(sql)
        .bind(...params)
        .all<T>()
    ).results;
  }

  async function createPat(): Promise<string> {
    const created = await body<{ token: string }>(
      send("POST", "/api/app/account/personal-access-tokens", {
        name: "health-test",
        expires_in_days: 30,
      }),
      201,
    );
    return created.token;
  }

  const endpoints = (entryId = "none") =>
    [
      { method: "GET", path: "/week" },
      { method: "GET", path: "/year" },
      { method: "GET", path: "/memos?ids=memos/a" },
      { method: "GET", path: "/targets" },
      {
        method: "PATCH",
        path: `/entries/${entryId}`,
        body: { variant: "push" },
      },
      { method: "POST", path: `/entries/${entryId}/dismiss` },
      { method: "POST", path: "/rescan" },
      { method: "GET", path: "/goals" },
      { method: "GET", path: "/trackers" },
      { method: "POST", path: "/trackers", body: FASTING },
      {
        method: "POST",
        path: "/trackers/test",
        body: { text: "fasted 16h", draft: { words: ["fasted"], blocked: [] } },
      },
      {
        method: "POST",
        path: "/trackers/preview",
        body: { words: ["fasted"], blocked: [] },
      },
      {
        method: "PUT",
        path: "/trackers/training",
        body: { words: ["hyrox"], blocked: [] },
      },
      { method: "DELETE", path: "/trackers/none" },
    ] as const;

  // ===========================================================================

  describe("authentication", () => {
    it("answers 401 to every endpoint without credentials", async () => {
      for (const entry of endpoints()) {
        for (const headers of [{}, { origin: ORIGIN }]) {
          const response = await request(entry.method, `${API}${entry.path}`, {
            body: "body" in entry ? entry.body : undefined,
            headers,
          });
          expect(response.status, `${entry.method} ${entry.path}`).toBe(401);
        }
        const bearer = await request(entry.method, `${API}${entry.path}`, {
          body: "body" in entry ? entry.body : undefined,
          headers: { authorization: "Bearer memos_pat_not_a_real_token" },
        });
        expect(bearer.status, `${entry.method} ${entry.path}`).toBe(401);
      }
      expect(await rows("SELECT * FROM health_entry")).toEqual([]);
      expect(await rows("SELECT * FROM health_sync_state")).toEqual([]);
    });

    it("refuses a cookie-session state change without FlareMo's Origin", async () => {
      await writeMemo("crossfit done");
      const [entry] = await rows<{ id: string }>("SELECT id FROM health_entry");
      for (const route of endpoints(entry?.id).filter(
        (e) => e.method !== "GET",
      )) {
        for (const origin of [
          undefined,
          "https://untrusted.example",
          "http://flaremo.test.evil.example",
          "null",
        ]) {
          const response = await request(route.method, `${API}${route.path}`, {
            body: "body" in route ? route.body : undefined,
            headers: {
              cookie: ctx.cookie,
              ...(origin === undefined ? {} : { origin }),
            },
          });
          expect(
            response.status,
            `${route.method} ${route.path} ${origin}`,
          ).toBe(403);
        }
      }
      const [after] = await rows<{ dismissed: number; variant: string }>(
        "SELECT dismissed, variant FROM health_entry",
      );
      expect(after).toEqual({ dismissed: 0, variant: "crossfit" });
      expect(await rows("SELECT * FROM health_target")).toEqual([]);
      expect(await rows("SELECT * FROM health_tracker")).toEqual([]);
    });

    it("lets a cookie session read without an Origin", async () => {
      for (const path of ["/week", "/year", "/memos?ids=memos/a", "/targets"]) {
        const response = await request("GET", `${API}${path}`, {
          headers: { cookie: ctx.cookie },
        });
        expect(response.status, path).toBe(200);
      }
    });

    it("accepts a personal access token without an Origin, and refuses an untrusted one", async () => {
      const token = await createPat();
      const bearer = { authorization: `Bearer ${token}` };
      expect(
        (await request("GET", `${API}/week`, { headers: bearer })).status,
      ).toBe(200);
      expect(
        (
          await request("POST", `${API}/rescan`, {
            headers: bearer,
          })
        ).status,
      ).toBe(200);
      for (const [method, path, requestBody] of [
        ["GET", `${API}/week`, undefined],
        ["POST", `${API}/rescan`, undefined],
      ] as const) {
        const response = await request(method, path, {
          body: requestBody,
          headers: { ...bearer, origin: "https://untrusted.example" },
        });
        expect(response.status, `${method} ${path}`).toBe(403);
      }
    });
  });

  describe("reading the diary through a memo save", () => {
    it("shows a saved memo's entries in the week, the labels and the year", async () => {
      const today = healthToday();
      const memo = await writeMemo("crossfit done, wim hof 10");
      await writeMemo("a note about nothing");

      const current = await week();
      expect(current.end).toBe(today);
      expect(
        current.entries.map((e) => [e.kind, e.variant, e.minutes]),
      ).toEqual([
        ["training", "crossfit", null],
        ["breath", "wim_hof", 10],
      ]);
      expect(current.summary.training).toEqual({ sessions: 1, target: 3 });
      expect(current.summary.breath).toMatchObject({ days: 1, minutes: 10 });

      const labels = onTheWire(
        healthMemosResponseSchema,
        await body<HealthMemosResponse>(
          send("GET", `${API}/memos?ids=${memo.name},memos/unknown`),
        ),
      ) as HealthMemosResponse;
      expect(labels.memos[memo.name]).toHaveLength(2);
      expect(labels.memos["memos/unknown"]).toEqual([]);

      const year = onTheWire(
        healthYearResponseSchema,
        await body<HealthYearResponse>(send("GET", `${API}/year`)),
      ) as HealthYearResponse;
      expect(year.days).toEqual([
        {
          day: today,
          training: 1,
          breath: 1,
          night_out: null,
          trackers: {},
        },
      ]);
    });

    it("follows an edit of the memo", async () => {
      const memo = await writeMemo("#gym back day done");
      const response = await send(
        "PATCH",
        `/api/app/memos/${encodeURIComponent(memo.id)}`,
        { content: "#gym chest day done" },
      );
      expect(response.status).toBe(200);
      expect((await week()).entries.map((e) => e.variant)).toEqual(["chest"]);
    });

    it("takes a start day", async () => {
      await writeMemo("wim hof 10");
      const far = await week("?start=2020-01-06");
      expect(far.entries).toEqual([]);
      expect(far.start).toBe("2020-01-06");
      expect(far.end).toBe("2020-01-12");
    });
  });

  describe("the first read", () => {
    it("reads the whole diary once, on the first call", async () => {
      await writeMemo("wim hof 10");
      // The history the hook never saw: an import writes memos directly.
      await ctx.d1.batch([
        ctx.d1.prepare("DELETE FROM health_entry_event"),
        ctx.d1.prepare("DELETE FROM health_entry"),
        ctx.d1.prepare("DELETE FROM health_sync_state"),
      ]);
      expect((await week()).entries).toHaveLength(1);
      const [marker] = await rows<{ memo_count: number }>(
        "SELECT memo_count FROM health_sync_state",
      );
      expect(marker?.memo_count).toBe(1);
    });

    it("re-reads on demand and reports what it did", async () => {
      await writeMemo("wim hof 10");
      await ctx.d1.batch([
        ctx.d1.prepare("DELETE FROM health_entry_event"),
        ctx.d1.prepare("DELETE FROM health_entry"),
      ]);
      const result = onTheWire(
        healthRescanResponseSchema,
        await body<HealthRescanResponse>(send("POST", `${API}/rescan`)),
      ) as HealthRescanResponse;
      expect(result).toEqual({ memos: 1, created: 1, updated: 0, removed: 0 });
    });
  });

  describe("fixing and dismissing", () => {
    async function night() {
      await writeMemo("went out Saturday");
      const current = await week("?start=2000-01-01");
      expect(current.entries).toEqual([]);
      const found = (await week()).entries.find((e) => e.kind === "night_out");
      expect(found?.needs_check).toBe(true);
      return found?.id ?? "";
    }

    it("answers home when? with a time", async () => {
      const id = await night();
      const patched = onTheWire(
        healthEntryResponseSchema,
        await body<HealthEntryResponse>(
          send("PATCH", `${API}/entries/${id}`, { home_at: "04:30" }),
        ),
      ) as HealthEntryResponse;
      expect(patched.entry).toMatchObject({
        home_at: "04:30",
        units: 1,
        needs_check: false,
      });
      const summary = (await week()).summary.night_out;
      expect(summary).toMatchObject({ units: 1, needs_check: 0, year_used: 1 });
    });

    it("rejects a bad body and an unknown row", async () => {
      const id = await night();
      for (const bad of [
        {},
        { home_at: "4:30" },
        { home_at: "25:00" },
        { minutes: 0 },
        { day: "2026-02-30" },
      ]) {
        const response = await send("PATCH", `${API}/entries/${id}`, bad);
        expect(response.status, JSON.stringify(bad)).toBe(400);
      }
      expect(
        (await send("PATCH", `${API}/entries/nope`, { variant: "push" }))
          .status,
      ).toBe(404);
      expect(
        (await send("PATCH", `${API}/entries/${id}`, { variant: "push" }))
          .status,
      ).toBe(400);
      expect((await send("POST", `${API}/entries/nope/dismiss`)).status).toBe(
        404,
      );
    });

    it("dismisses a label for good", async () => {
      const memo = await writeMemo("crossfit done");
      const [entry] = (await week()).entries;
      await body(send("POST", `${API}/entries/${entry?.id}/dismiss`));
      expect((await week()).entries).toEqual([]);
      // Neither a rescan nor an edit of the memo brings it back.
      await body(send("POST", `${API}/rescan`));
      await send("PATCH", `/api/app/memos/${encodeURIComponent(memo.id)}`, {
        content: "crossfit done again",
      });
      expect((await week()).entries).toEqual([]);
      expect(
        await rows<{ action: string }>(
          "SELECT action FROM health_entry_event ORDER BY at, rowid",
        ),
      ).toEqual([{ action: "create" }, { action: "dismiss" }]);
    });
  });

  describe("targets", () => {
    it("starts at the defaults", async () => {
      const first = onTheWire(
        healthTargetsResponseSchema,
        await body<HealthTargetsResponse>(send("GET", `${API}/targets`)),
      ) as HealthTargetsResponse;
      expect(first.targets.map((t) => [t.kind, t.period, t.amount])).toEqual([
        ["training", "week", 3],
        ["breath", "week", 7],
        ["night_out", "year", 12],
      ]);
    });

    it("has no route that sets them", async () => {
      const response = await send("PUT", `${API}/targets`, {
        targets: [{ kind: "training", period: "week", amount: 4 }],
      });
      expect(response.status).toBe(404);
    });
  });

  describe("trackers", () => {
    it("creates a tracker, reads the diary with it and lists it", async () => {
      await writeMemo("Fasted 18h, felt clear");
      const saved = onTheWire(
        healthTrackerSaveResponseSchema,
        await body<HealthTrackerSaveResponse>(
          send("POST", `${API}/trackers`, FASTING),
          201,
        ),
      );
      const fasting = saved.trackers.find((tracker) => !tracker.builtin);
      expect(fasting).toMatchObject({
        label: "Fasting",
        words: ["#fast", "fasted"],
        color: "green",
      });
      expect(saved.rescan.created).toBe(1);
      const current = await week();
      expect(current.trackers).toEqual([
        { kind: fasting?.kind, days: 1, minutes: 1080 },
      ]);
      const listed = onTheWire(
        healthTrackersResponseSchema,
        await body<HealthTrackersResponse>(send("GET", `${API}/trackers`)),
      );
      expect(listed.trackers.map((tracker) => tracker.label)).toEqual([
        "Training",
        "Breath",
        "Nights out",
        "Fasting",
      ]);
      // Not linked to a goal, so no goal card shows it.
      expect(
        onTheWire(
          healthGoalProgressResponseSchema,
          await body<HealthGoalProgressResponse>(send("GET", `${API}/goals`)),
        ),
      ).toEqual({ progress: [] });

      const archived = await body<HealthTrackerSaveResponse>(
        send("DELETE", `${API}/trackers/${fasting?.id}`),
      );
      expect(archived.rescan.removed).toBe(1);
      expect((await week()).trackers).toEqual([]);
    });

    it("previews and tests without writing anything", async () => {
      await writeMemo("OMAD today");
      const preview = onTheWire(
        healthTrackerPreviewResponseSchema,
        await body<HealthTrackerPreviewResponse>(
          send("POST", `${API}/trackers/preview`, {
            measure: "days",
            words: ["omad"],
            blocked: [],
          }),
        ),
      );
      expect(preview).toMatchObject({ added: 1, removed: 0, memos: 1 });
      const tested = await body<{ reason: string }>(
        send("POST", `${API}/trackers/test`, {
          text: "no omad today",
          draft: { words: ["omad"], blocked: [] },
        }),
      );
      expect(tested.reason).toBe("negated");
      expect(await rows("SELECT * FROM health_tracker")).toEqual([]);
    });

    it("gives a built-in extra words, and refuses a bad tracker", async () => {
      await writeMemo("hyrox done");
      await body(
        send("PUT", `${API}/trackers/training`, {
          words: ["hyrox"],
          blocked: [],
        }),
      );
      const [row] = await rows<{ kind: string }>(
        "SELECT kind FROM health_entry WHERE deleted_at IS NULL",
      );
      expect(row?.kind).toBe("training");
      for (const bad of [
        { ...FASTING, words: [] },
        { ...FASTING, label: "" },
        { ...FASTING, color: "purple" },
        { ...FASTING, goal_id: "no-such-goal" },
      ]) {
        const response = await send("POST", `${API}/trackers`, bad);
        expect(response.status, JSON.stringify(bad)).toBe(400);
      }
    });
  });

  describe("routing", () => {
    it("leaves upstream's /api/app/health alone", async () => {
      const response = await send("GET", "/api/app/health");
      const info = await body<{ ok: boolean }>(response);
      expect(info.ok).toBe(true);
    });

    it("answers unknown paths with the JSON 404 envelope", async () => {
      const response = await send("GET", `${API}/nothing-here`);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { message: "Not found" },
      });
    });
  });
});
