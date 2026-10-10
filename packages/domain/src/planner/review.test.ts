import {
  plannerReviewStateMax,
  plannerSummaryMemoClientId,
} from "@flaremo/contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, ValidationError } from "../errors";
import { createMemo, updateMemo } from "../memos-write";
import type { TaskActor } from "../tasks";
import { plannerReadBoard } from "./board";
import { plannerCreateGoal, plannerReadWeek, plannerUpsertWeek } from "./goals";
import {
  type PlannerCommitBody,
  type PlannerLookBackBody,
  plannerCommitPlan,
  plannerReadReview,
  plannerReviewStatus,
  plannerSaveLookBack,
  plannerSaveReviewState,
} from "./review";
import { plannerReadLastQuestion } from "./review-context";
import {
  type PlannerTestRuntime,
  plannerTestEvents,
  plannerTestInsertPlan,
  plannerTestInsertTask,
  plannerTestPlan,
  plannerTestRows,
  plannerTestRun,
  plannerTestRuntime,
} from "./test-support";

// The weekly review's reads and saves (review.ts, migration 9005).

const USER: TaskActor = { type: "user" };
const SUNDAY = "2026-10-11";
const W40 = "2026-09-28";
const W41 = "2026-10-05";
const W42 = "2026-10-12";

const W40_SUMMARY = [
  "# Week 40: September 28 - October 4, 2026",
  "",
  "### I. Objective Function",
  "- **Next Steps:** Compare Acme and Zeta on numbers",
  "",
  "### III. AI Chops",
  "- **Next Steps:** Ship the first public artifact",
  "",
  "**Key question for W41's review:** *Did I compare the offers on numbers?*",
].join("\n");

const W41_MEMO = [
  "# Week 41: October 5 - October 11, 2026",
  "",
  "### I. Objective Function",
  "- **Next Steps:** Get the Acme terms on paper",
  "",
  "**Key question for W42's review:** Did I get the terms on paper?",
  "",
  "**Verdict: Pivot toward the terms.** They moved fast.",
].join("\n");

type MemoRowOut = {
  id: string;
  content: string;
  source: string;
  client_id: string | null;
  status: string;
};

describe("the weekly review", () => {
  let rt: PlannerTestRuntime;

  beforeAll(async () => {
    rt = await plannerTestRuntime("flaremo-planner-review");
  });
  afterAll(async () => {
    await rt.dispose();
  });
  beforeEach(async () => {
    await rt.reset();
    await rt.database.batch(
      ["memo_tags", "memo_revisions", "memos"].map((table) =>
        rt.database.prepare(`DELETE FROM ${table}`),
      ),
    );
  });

  const read = (today: string, week?: string) =>
    plannerReadReview(rt.db, { userId: rt.user.id, today, week, ai: true });

  const weekGoal = (
    weekStart: string,
    pillar: "of" | "work" | "ai" | "health",
    title: string,
  ) =>
    plannerCreateGoal(rt.db, {
      userId: rt.user.id,
      goal: { level: "week", periodStart: weekStart, pillar, title },
    });

  const insertFlag = (flag: {
    id: string;
    weekStart: string;
    state?: "open" | "kept" | "rewritten";
    goalId?: string | null;
    withGoalId?: string | null;
    pillar?: string | null;
    createdAt: string;
  }) =>
    plannerTestRun(
      rt.database,
      `INSERT INTO planner_goal_flag (id, user_id, week_start, goal_id, pillar, with_goal_id, with_label, why, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      flag.id,
      rt.user.id,
      flag.weekStart,
      flag.goalId ?? null,
      flag.pillar ?? null,
      flag.withGoalId ?? null,
      "Year · Work",
      "The year goal says stay; the note says go.",
      flag.state ?? "open",
      flag.createdAt,
    );

  const count = async (sql: string, ...params: unknown[]) =>
    (await plannerTestRows<{ n: number }>(rt.database, sql, ...params))[0]?.n ??
    -1;

  const summaryMemos = () =>
    plannerTestRows<MemoRowOut>(
      rt.database,
      "SELECT id, content, source, client_id, status FROM memos WHERE client_id = ?",
      plannerSummaryMemoClientId(W41),
    );

  const lookBack = (overrides: Partial<PlannerLookBackBody> = {}) =>
    plannerSaveLookBack(rt.db, {
      user: rt.user,
      weekStart: W41,
      body: {
        today: SUNDAY,
        scores: { auth: 4, ach: 3 },
        question: "Did I get the terms on paper?",
        verdict: {
          kind: "pivot",
          text: "Pivot toward the terms. They moved fast.",
        },
        goal_results: [],
        memo: W41_MEMO,
        ...overrides,
      },
    });

  describe("the page's read", () => {
    it("looks back on the week today points at, and never on one to come", async () => {
      expect((await read(SUNDAY)).review_week).toBe(W41);
      expect((await read(SUNDAY)).plan_week).toBe(W42);
      expect((await read("2026-10-14")).review_week).toBe(W41);
      expect((await read("2026-10-17")).review_week).toBe(W42);
      expect((await read(SUNDAY, W40)).review_week).toBe(W40);
      await expect(read(SUNDAY, W42)).rejects.toThrow(ValidationError);
      await expect(read(SUNDAY, "2026-10-06")).rejects.toThrow(ValidationError);

      const empty = await read(SUNDAY);
      expect(empty).toMatchObject({
        state: null,
        look_back_done_at: null,
        look_forward_done_at: null,
        last_question: null,
        week_goals: [],
        plan_goals: [],
        flags: [],
        week: null,
        summary: null,
        suggested_goals: {},
        ai: true,
      });
      expect(empty.scores).toHaveLength(19);
      expect(empty.scores[0]).toEqual({
        week_start: "2026-06-01",
        auth: null,
        ach: null,
      });
      expect(empty.scores.at(-1)?.week_start).toBe(W41);
    });

    it("gathers last week's question, the goals, the open flags and the Next Steps", async () => {
      await plannerUpsertWeek(rt.db, {
        userId: rt.user.id,
        weekStart: W40,
        patch: {
          auth: 4,
          ach: 3.5,
          question: "Did I compare?",
          source: "import",
        },
      });
      await createMemo(rt.db, rt.user, {
        content: W40_SUMMARY,
        visibility: "private",
        payload: { tags: ["vault-summary"] },
        source: "vault-import",
      });
      const year = await plannerCreateGoal(rt.db, {
        userId: rt.user.id,
        goal: {
          level: "year",
          periodStart: "2026-01-01",
          pillar: "work",
          title: "Stay on better terms",
        },
      });
      await weekGoal(W41, "work", "Ask for the terms");
      await weekGoal(W41, "of", "Compare the offers");
      await weekGoal(W42, "health", "Gym runs twice");
      await insertFlag({
        id: "flag-old",
        weekStart: W40,
        withGoalId: year.id,
        pillar: "work",
        createdAt: "2026-09-27T10:00:00.000Z",
      });
      await insertFlag({
        id: "flag-new",
        weekStart: W41,
        createdAt: "2026-10-04T10:00:00.000Z",
      });
      await insertFlag({
        id: "flag-kept",
        weekStart: W40,
        state: "kept",
        createdAt: "2026-09-27T11:00:00.000Z",
      });
      await insertFlag({
        id: "flag-later",
        weekStart: W42,
        createdAt: "2026-10-11T10:00:00.000Z",
      });

      const review = await read(SUNDAY);
      expect(review.last_question).toBe("Did I compare?");
      expect(review.week_goals.map((goal) => goal.title)).toEqual([
        "Compare the offers",
        "Ask for the terms",
      ]);
      expect(review.plan_goals.map((goal) => goal.title)).toEqual([
        "Gym runs twice",
      ]);
      expect(review.flags.map((flag) => flag.id)).toEqual([
        "flag-old",
        "flag-new",
      ]);
      expect(review.flag_goals.map((goal) => goal.id)).toEqual([year.id]);
      expect(review.scores.at(-2)).toEqual({
        week_start: W40,
        auth: 4,
        ach: 3.5,
      });
      // No W41 summary yet, so the plan starts from W40's Next Steps.
      expect(review.summary).toBeNull();
      expect(review.suggested_goals).toEqual({
        of: "Compare Acme and Zeta on numbers",
        ai: "Ship the first public artifact",
      });
    });

    it("reads last week's question from its summary when the record has none", async () => {
      await createMemo(rt.db, rt.user, {
        content: W40_SUMMARY,
        visibility: "private",
        payload: { tags: ["vault-summary"] },
        source: "vault-import",
      });
      expect(
        await plannerReadLastQuestion(rt.db, {
          userId: rt.user.id,
          weekStart: W41,
        }),
      ).toBe("Did I compare the offers on numbers?");
    });

    it("is due from Saturday to Monday until both parts are done", async () => {
      const status = (today: string) =>
        plannerReviewStatus(rt.db, { userId: rt.user.id, today });
      expect(await status("2026-10-10")).toEqual({
        review_week: W41,
        due: true,
        look_back_done: false,
        look_forward_done: false,
      });
      expect((await status("2026-10-12")).due).toBe(true);
      expect((await status("2026-10-14")).due).toBe(false);
      await plannerTestRun(
        rt.database,
        `INSERT INTO planner_review (user_id, week_start, look_back_done_at, look_forward_done_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        rt.user.id,
        W41,
        "2026-10-11T10:00:00.000Z",
        "2026-10-11T11:00:00.000Z",
        "2026-10-11T09:00:00.000Z",
        "2026-10-11T11:00:00.000Z",
      );
      expect(await status(SUNDAY)).toEqual({
        review_week: W41,
        due: false,
        look_back_done: true,
        look_forward_done: true,
      });
      expect((await status("2026-10-12")).due).toBe(false);
    });

    it("keeps the page's own state, replacing it on each save", async () => {
      await plannerSaveReviewState(rt.db, {
        userId: rt.user.id,
        weekStart: W41,
        state: { part: "back", step: 2 },
      });
      await plannerSaveReviewState(rt.db, {
        userId: rt.user.id,
        weekStart: W41,
        state: { part: "forward", step: 1 },
      });
      expect((await read(SUNDAY)).state).toEqual({ part: "forward", step: 1 });
      await expect(
        plannerSaveReviewState(rt.db, {
          userId: rt.user.id,
          weekStart: W41,
          state: { blob: "x".repeat(plannerReviewStateMax) },
        }),
      ).rejects.toThrow(ValidationError);
      await expect(
        plannerSaveReviewState(rt.db, {
          userId: rt.user.id,
          weekStart: "2026-10-07",
          state: {},
        }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("Look back", () => {
    it("writes the summary memo, the week's record and the goal results", async () => {
      const met = await weekGoal(W41, "work", "Ask for the terms");
      const partly = await weekGoal(W41, "health", "Gym runs twice");
      const result = await lookBack({
        goal_results: [
          { goal_id: met.id, result: "met" },
          { goal_id: partly.id, result: "partial" },
          { goal_id: crypto.randomUUID(), result: "missed" },
        ],
      });

      const [memo] = await summaryMemos();
      expect(memo).toMatchObject({
        id: result.memo_id,
        source: "weekly-review",
        status: "normal",
      });
      expect(memo?.content.startsWith("# Week 41: October 5")).toBe(true);
      expect(
        memo?.content.endsWith("<!-- flaremo:diary 2026-10-05..2026-10-11 -->"),
      ).toBe(true);
      expect(
        await plannerTestRows(
          rt.database,
          "SELECT tag FROM memo_tags WHERE memo_id = ?",
          result.memo_id,
        ),
      ).toEqual([{ tag: "vault-summary" }]);
      expect(result.week).toMatchObject({
        week_start: W41,
        auth: 4,
        ach: 3,
        question: "Did I get the terms on paper?",
        verdict: "Pivot toward the terms. They moved fast.",
        memo_id: result.memo_id,
        source: "review",
      });
      expect(result.week.reviewed_at).not.toBeNull();

      const review = await read(SUNDAY);
      expect(review.look_back_done_at).not.toBeNull();
      expect(
        Object.fromEntries(
          review.week_goals.map((goal) => [goal.title, goal.result]),
        ),
      ).toEqual({ "Ask for the terms": "met", "Gym runs twice": "partial" });
      expect(review.summary?.id).toBe(result.memo_id);
      // The plan now starts from this week's Next Steps.
      expect(review.suggested_goals).toEqual({
        of: "Get the Acme terms on paper",
      });
      // And next week's review reads the question back.
      expect(
        await plannerReadLastQuestion(rt.db, {
          userId: rt.user.id,
          weekStart: W42,
        }),
      ).toBe("Did I get the terms on paper?");
    });

    it("saves again into the same memo and brings a trashed one back", async () => {
      const first = await lookBack();
      const second = await lookBack({ memo: `${W41_MEMO}\n\nOne more line.` });
      expect(second.memo_id).toBe(first.memo_id);
      let memos = await summaryMemos();
      expect(memos).toHaveLength(1);
      expect(memos[0]?.content).toContain("One more line.");

      await updateMemo(rt.db, rt.user, first.memo_id, { status: "trashed" });
      const third = await lookBack({ memo: `${W41_MEMO}\n\nWritten again.` });
      expect(third.memo_id).toBe(first.memo_id);
      memos = await summaryMemos();
      expect(memos).toHaveLength(1);
      expect(memos[0]).toMatchObject({ status: "normal" });
      expect(memos[0]?.content).toContain("Written again.");
    });

    it("refuses a week that has not started and scores off the scale", async () => {
      await expect(
        plannerSaveLookBack(rt.db, {
          user: rt.user,
          weekStart: W42,
          body: {
            today: SUNDAY,
            scores: { auth: 4, ach: 3 },
            question: null,
            verdict: null,
            goal_results: [],
            memo: W41_MEMO,
          },
        }),
      ).rejects.toThrow(ValidationError);
      await expect(lookBack({ scores: { auth: 0.5, ach: 3 } })).rejects.toThrow(
        ValidationError,
      );
      expect(await summaryMemos()).toHaveLength(0);
    });
  });

  describe("Look forward", () => {
    const G1 = "11111111-1111-4111-8111-111111111111";
    const G2 = "22222222-2222-4222-8222-222222222222";

    /** A board: two To Do cards, one Backlog card and one in Doing. */
    const seedBoard = async () => {
      for (const [name, status] of [
        ["a-old", "todo"],
        ["b-keep", "todo"],
        ["c-backlog", "todo"],
        ["d-doing", "in_progress"],
      ] as const) {
        await plannerTestInsertTask(rt.database, {
          id: `tasks/${name}`,
          userId: rt.user.id,
          title: name,
          status,
          createdAt: "2026-10-01T08:00:00.000Z",
        });
      }
      for (const name of ["a-old", "b-keep"]) {
        await plannerTestInsertPlan(rt.database, {
          taskId: `tasks/${name}`,
          userId: rt.user.id,
          horizon: "day",
          periodStart: "2026-10-07",
        });
      }
    };

    const body = (
      overrides: Partial<PlannerCommitBody> = {},
    ): PlannerCommitBody => ({
      today: SUNDAY,
      goals: [
        { id: G1, pillar: "work", title: "Get the Acme terms in writing" },
        { id: G2, pillar: "health", title: "Gym runs twice" },
      ],
      tasks: [
        { ref: "t1", goal_id: G1, task_id: "tasks/c-backlog" },
        { ref: "t2", goal_id: G1, title: "Email Acme" },
        { ref: "t3", goal_id: G2, task_id: "tasks/b-keep" },
      ],
      to_backlog: ["tasks/a-old"],
      question: "Did I get the terms on paper?",
      settled: [],
      flags: [],
      ...overrides,
    });

    const commit = (input: PlannerCommitBody = body()) =>
      plannerCommitPlan(rt.db, {
        user: rt.user,
        actor: USER,
        weekStart: W41,
        body: input,
      });

    const columns = async () => {
      const board = await plannerReadBoard(rt.db, {
        userId: rt.user.id,
        today: SUNDAY,
      });
      const title = (id: string) =>
        [
          ...board.columns.todo,
          ...board.columns.backlog,
          ...board.columns.doing,
        ].find((card) => card.id === id)?.title;
      return {
        todo: board.columns.todo.map((card) => title(card.id)),
        backlog: board.columns.backlog.map((card) => title(card.id)),
        goals: Object.fromEntries(
          [...board.columns.todo, ...board.columns.backlog].map((card) => [
            card.title,
            card.goal_id,
          ]),
        ),
      };
    };

    it("plans the next week: goals, linked and new tasks, To Do order, flags and the question", async () => {
      await seedBoard();
      const yearWork = await plannerCreateGoal(rt.db, {
        userId: rt.user.id,
        goal: {
          level: "year",
          periodStart: "2026-01-01",
          pillar: "work",
          title: "Stay on better terms",
          lines: [{ text: "Grade A title" }],
          status: "contested",
          note: "A 6 Oct note says join Acme",
        },
      });
      await insertFlag({
        id: "f-rewrite",
        weekStart: W41,
        withGoalId: yearWork.id,
        pillar: "work",
        createdAt: "2026-10-04T10:00:00.000Z",
      });
      await insertFlag({
        id: "f-keep",
        weekStart: W41,
        pillar: "of",
        createdAt: "2026-10-04T11:00:00.000Z",
      });

      const result = await commit(
        body({
          settled: [
            {
              flag_id: "f-rewrite",
              state: "rewritten",
              title: "Join Acme from 1 January on a written deal",
            },
            { flag_id: "f-keep", state: "kept" },
          ],
          flags: [
            {
              goal_id: G1,
              pillar: "work",
              with_goal_id: yearWork.id,
              with_label: "Year · Work",
              why: "Works toward Acme while the year goal said stay.",
            },
          ],
        }),
      );

      expect(result.plan_week).toBe(W42);
      expect(result.goals.map((goal) => [goal.id, goal.title])).toEqual([
        [G1, "Get the Acme terms in writing"],
        [G2, "Gym runs twice"],
      ]);
      expect(Object.keys(result.created)).toEqual(["t2"]);
      const emailId = result.created.t2 as string;

      expect(await columns()).toEqual({
        todo: ["c-backlog", "Email Acme", "b-keep"],
        backlog: ["a-old"],
        goals: {
          "c-backlog": G1,
          "Email Acme": G1,
          "b-keep": G2,
          "a-old": null,
        },
      });
      expect(
        (await plannerTestEvents(rt.database, emailId)).map(
          (event) => event.type,
        ),
      ).toEqual(expect.arrayContaining(["planned", "goal_changed"]));

      const flags = await plannerTestRows<{
        id: string;
        week_start: string;
        state: string;
        goal_id: string | null;
        with_goal_id: string | null;
        settled_at: string | null;
      }>(rt.database, "SELECT * FROM planner_goal_flag ORDER BY created_at");
      expect(flags.find((flag) => flag.id === "f-rewrite")).toMatchObject({
        state: "rewritten",
      });
      expect(flags.find((flag) => flag.id === "f-keep")).toMatchObject({
        state: "kept",
      });
      expect(
        flags.find((flag) => flag.id === "f-keep")?.settled_at,
      ).not.toBeNull();
      expect(flags.filter((flag) => flag.week_start === W42)).toEqual([
        expect.objectContaining({
          state: "open",
          goal_id: G1,
          with_goal_id: yearWork.id,
        }),
      ]);

      const [rewritten] = await plannerTestRows<{
        title: string;
        lines: string;
        status: string;
        note: string | null;
      }>(
        rt.database,
        "SELECT title, lines, status, note FROM planner_goal WHERE id = ?",
        yearWork.id,
      );
      expect(rewritten).toEqual({
        title: "Join Acme from 1 January on a written deal",
        lines: "[]",
        status: "active",
        note: null,
      });

      expect(
        (await plannerReadWeek(rt.db, { userId: rt.user.id, weekStart: W41 }))
          ?.question,
      ).toBe("Did I get the terms on paper?");
      const review = await read(SUNDAY);
      expect(review.look_forward_done_at).not.toBeNull();
      expect(review.plan_goals.map((goal) => goal.id)).toEqual([G1, G2]);
      // Settled flags are no longer open; the new one waits for next week.
      expect(review.flags).toEqual([]);
    });

    it("can be saved again without making anything twice, and follows a changed plan", async () => {
      await seedBoard();
      const first = await commit();
      const again = await commit();
      expect(again.created).toEqual(first.created);
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM tasks WHERE title = ?",
          "Email Acme",
        ),
      ).toBe(1);
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM planner_goal WHERE level = 'week' AND period_start = ? AND deleted_at IS NULL",
          W42,
        ),
      ).toBe(2);
      expect((await columns()).todo).toEqual([
        "c-backlog",
        "Email Acme",
        "b-keep",
      ]);

      // The second goal and its task leave the plan.
      const changed = await commit(
        body({
          goals: [
            { id: G1, pillar: "work", title: "Get the terms in writing" },
          ],
          tasks: [
            { ref: "t1", goal_id: G1, task_id: "tasks/c-backlog" },
            { ref: "t2", goal_id: G1, title: "Email Acme" },
          ],
        }),
      );
      expect(changed.goals.map((goal) => goal.title)).toEqual([
        "Get the terms in writing",
      ]);
      expect(changed.created).toEqual(first.created);
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM planner_goal WHERE id = ? AND deleted_at IS NOT NULL",
          G2,
        ),
      ).toBe(1);
      const kept = await plannerTestPlan(rt.database, "tasks/b-keep");
      expect(kept).toMatchObject({ goal_id: null, horizon: "day" });
      const unlinked = (await plannerTestEvents(rt.database, "tasks/b-keep"))
        .filter((event) => event.type === "goal_changed")
        .map((event) => JSON.parse(event.data));
      expect(unlinked).toEqual([
        { from: null, to: G2 },
        { from: G2, to: null },
      ]);
    });

    it("puts the question chosen in Look forward into the summary memo", async () => {
      await seedBoard();
      await lookBack();
      await commit(body({ question: "Did I sign by Friday?" }));
      const [memo] = await summaryMemos();
      expect(memo?.content).toContain(
        "**Key question for W42's review:** Did I sign by Friday?",
      );
      expect(memo?.content).not.toContain("Did I get the terms on paper?");
      expect(
        await plannerTestRows(
          rt.database,
          "SELECT tag FROM memo_tags WHERE memo_id = ?",
          memo?.id,
        ),
      ).toEqual([{ tag: "vault-summary" }]);
      expect(
        (await plannerReadWeek(rt.db, { userId: rt.user.id, weekStart: W41 }))
          ?.question,
      ).toBe("Did I sign by Friday?");
    });

    it("refuses goal ids that belong to someone else or to another week", async () => {
      await seedBoard();
      const theirs = await plannerCreateGoal(rt.db, {
        userId: rt.other.id,
        goal: {
          level: "week",
          periodStart: W42,
          pillar: "work",
          title: "Theirs",
        },
      });
      await expect(
        commit(
          body({
            goals: [{ id: theirs.id, pillar: "work", title: "Mine now" }],
            tasks: [],
          }),
        ),
      ).rejects.toThrow(ConflictError);
      const lastWeek = await weekGoal(W41, "work", "Last week's");
      await expect(
        commit(
          body({
            goals: [{ id: lastWeek.id, pillar: "work", title: "Moved" }],
            tasks: [],
          }),
        ),
      ).rejects.toThrow(ValidationError);
      await expect(
        commit(
          body({
            tasks: [{ ref: "x", goal_id: crypto.randomUUID(), title: "Stray" }],
          }),
        ),
      ).rejects.toThrow(ValidationError);
      // Nothing was written by the refused saves.
      expect(
        await count(
          "SELECT COUNT(*) AS n FROM tasks WHERE title = ?",
          "Email Acme",
        ),
      ).toBe(0);
      expect((await columns()).backlog).toEqual(["c-backlog"]);
    });
  });
});
