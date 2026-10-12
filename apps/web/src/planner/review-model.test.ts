import {
  type PlannerAiCheckResponse,
  type PlannerAiCloseResponse,
  type PlannerAiOpeningResponse,
  type PlannerBoardCard,
  type PlannerBoardResponse,
  type PlannerGoalDto,
  type PlannerReviewChatMessage,
  type PlannerReviewResponse,
  type PlannerWeekDto,
  plannerAiCheckSchema,
  plannerAiCloseSchema,
  plannerAiCoachSchema,
  plannerAiMemoSchema,
  plannerCommitSchema,
  plannerComposeSummaryMemo,
  plannerLookBackSchema,
  plannerReviewPrompts,
} from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  type PlannerBackState,
  type PlannerForwardState,
  type PlannerPlanGoal,
  type PlannerPlanTask,
  type PlannerReviewDrafts,
  type PlannerReviewState,
  plannerAddAnswer,
  plannerAddBoardTask,
  plannerAddCoachReply,
  plannerAddNewTask,
  plannerAddProbe,
  plannerAdvance,
  plannerAfterCommit,
  plannerAnswersInput,
  plannerCheckFlags,
  plannerCheckInput,
  plannerCoachMessages,
  plannerCoachMode,
  plannerCommitInput,
  plannerDraftsOf,
  plannerFallbackDrafts,
  plannerFallbackRecap,
  plannerGoalResultsInput,
  plannerInitialPlanGoals,
  plannerLookBackInput,
  plannerMemoDrafts,
  plannerMergeClose,
  plannerMergeOpening,
  plannerNamedGoals,
  plannerNewBackState,
  plannerNewForwardState,
  plannerNewId,
  plannerNewReviewState,
  plannerOpenQuestions,
  plannerOpenScores,
  plannerOtherTodo,
  plannerPastStage,
  plannerPickableCards,
  plannerPlanFromMemo,
  plannerPlanQuestion,
  plannerPlanSignature,
  plannerPrefillTasks,
  plannerRestoreReviewState,
  plannerSettledInput,
  plannerStepScore,
  plannerSummaryInput,
  plannerSysOnce,
  plannerTodoCount,
  plannerVerdictKindOf,
} from "./review-model";

// The weekly review on Sunday 11 October 2026 looks back on Week 41 (Monday 5
// October) and plans Week 42 (Monday 12 October).
const TODAY = "2026-10-11";
const REVIEW_WEEK = "2026-10-05";
const LAST_WEEK = "2026-09-28";
const PLAN_WEEK = "2026-10-12";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let sequence = 0;

/** A UUID the server's schemas accept, different on every call. */
function uuid(): string {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function goal(overrides: Partial<PlannerGoalDto> = {}): PlannerGoalDto {
  return {
    id: uuid(),
    level: "week",
    period_start: REVIEW_WEEK,
    pillar: "work",
    title: "Ship the billing page",
    lines: [],
    status: "active",
    note: null,
    result: null,
    sort_order: 0,
    created_at: "2026-10-04T18:00:00.000Z",
    updated_at: "2026-10-04T18:00:00.000Z",
    ...overrides,
  };
}

function weekRecord(overrides: Partial<PlannerWeekDto> = {}): PlannerWeekDto {
  return {
    week_start: REVIEW_WEEK,
    auth: null,
    ach: null,
    note: null,
    question: null,
    verdict: null,
    memo_id: null,
    source: "review",
    reviewed_at: null,
    ...overrides,
  };
}

function review(
  overrides: Partial<PlannerReviewResponse> = {},
): PlannerReviewResponse {
  return {
    today: TODAY,
    review_week: REVIEW_WEEK,
    plan_week: PLAN_WEEK,
    state: null,
    look_back_done_at: null,
    look_forward_done_at: null,
    last_question: null,
    week_goals: [],
    plan_goals: [],
    flags: [],
    flag_goals: [],
    scores: [],
    week: null,
    summary: null,
    suggested_goals: {},
    ai: true,
    ...overrides,
  };
}

function opening(
  overrides: Partial<PlannerAiOpeningResponse> = {},
): PlannerAiOpeningResponse {
  return {
    recap: "The beta shipped; two runs, not three.",
    lastq: ["Yes, on Friday", "Partly", "No"],
    prompts: plannerReviewPrompts.map((prompt) => [
      `${prompt.label}: more`,
      `${prompt.label}: less`,
    ]),
    ...overrides,
  };
}

function close(
  overrides: {
    scores?: Partial<PlannerAiCloseResponse["scores"]>;
    trajectory?: Partial<PlannerAiCloseResponse["trajectory"]>;
  } = {},
): PlannerAiCloseResponse {
  return {
    scores: {
      auth: 4.5,
      ach: 3,
      auth_evidence: "Named the skipped runs before being asked.",
      ach_evidence: "The beta shipped; the invoices slipped.",
      ...overrides.scores,
    },
    trajectory: {
      pattern: "Shipping crowds out the admin.",
      risk: "The invoices slip a third week.",
      opportunity: "Two warm leads from the beta.",
      questions: [
        "Did I send the invoices on Monday?",
        "Did I run three times?",
        "Did I call both leads?",
      ],
      verdicts: {
        continue: "Continue. The shipping cadence holds.",
        pivot: "Pivot toward sales, away from features. Two leads went cold.",
        pause:
          "Pause for pricing. Without answering this, next week risks another rewrite.",
      },
      recommended: "pivot",
      ...overrides.trajectory,
    },
  };
}

function card(overrides: Partial<PlannerBoardCard> = {}): PlannerBoardCard {
  sequence += 1;
  const id = overrides.id ?? `tasks/t${String(sequence).padStart(3, "0")}`;
  return {
    id,
    project_id: null,
    project_name: null,
    title: `Task ${id}`,
    status: "todo",
    priority: "none",
    due_at: null,
    sort_order: 0,
    completed_at: null,
    created_at: "2026-10-01T08:00:00.000Z",
    updated_at: "2026-10-01T08:00:00.000Z",
    horizon: null,
    period_start: null,
    carry_count: 0,
    dropped_at: null,
    start_date: null,
    board_rank: null,
    goal_id: null,
    ...overrides,
  };
}

function board(
  columns: Partial<PlannerBoardResponse["columns"]> = {},
): PlannerBoardResponse {
  return {
    columns: {
      backlog: [],
      todo: [],
      doing: [],
      done: [],
      other: [],
      ...columns,
    },
    today: TODAY,
    periods: { day: TODAY, week: REVIEW_WEEK, month: "2026-10-01" },
    history: "ok",
    truncated: false,
  };
}

function planGoal(overrides: Partial<PlannerPlanGoal> = {}): PlannerPlanGoal {
  return {
    id: uuid(),
    pillar: "work",
    title: "Close two customers",
    ...overrides,
  };
}

function task(
  goalId: string,
  overrides: Partial<PlannerPlanTask> = {},
): PlannerPlanTask {
  sequence += 1;
  return {
    ref: uuid(),
    goal_id: goalId,
    title: `Task ${sequence}`,
    source: "new",
    ...overrides,
  };
}

/** Look forward, opened on Plan tasks after the board's cards were added. */
function forward(
  overrides: Partial<PlannerForwardState> = {},
): PlannerForwardState {
  return {
    seen: true,
    step: 3,
    settled: {},
    goals: [],
    tasks: [],
    toBacklog: [],
    question: null,
    edited: false,
    prefilled: true,
    ...overrides,
  };
}

/** Look back once Start was pressed and the drafts are in: the recap, then the first thing to answer. */
function opened(
  r: PlannerReviewResponse,
  drafts: PlannerReviewDrafts = plannerFallbackDrafts(r),
): PlannerBackState {
  return plannerOpenQuestions(
    { ...plannerNewBackState(r), stage: "drafting" },
    r,
    drafts,
  );
}

/** Look back asking prompt `pi` (0 to 6), the earlier ones skipped. */
function atPrompt(
  pi: number,
  r: PlannerReviewResponse = review(),
): PlannerBackState {
  let back = opened(r);
  for (let guard = 0; guard < 20; guard += 1) {
    if (back.stage === "p" && back.pi >= pi) break;
    back = plannerAdvance(back, r);
  }
  return back;
}

/** Look back at the score card, the seven prompts behind it. */
function atScores(r: PlannerReviewResponse = review()): PlannerBackState {
  const scoring = plannerAdvance(atPrompt(6, r), r);
  return plannerOpenScores(scoring, plannerDraftsOf(scoring, r));
}

const atQuestion = (r: PlannerReviewResponse = review()) =>
  plannerAdvance(atScores(r), r);
const atVerdict = (r: PlannerReviewResponse = review()) =>
  plannerAdvance(atQuestion(r), r);

/** Look back walked to the end without a model, one answer to everything. */
function finished(r: PlannerReviewResponse = review()): PlannerBackState {
  let back = opened(r);
  if (back.stage === "lastq") {
    back = plannerAdvance(plannerAddAnswer(back, r, "Partly").back, r);
  }
  if (back.stage === "goals") back = plannerAdvance(back, r);
  for (const prompt of plannerReviewPrompts) {
    const said = plannerAddAnswer(back, r, `${prompt.label}: it went fine`);
    back = plannerAdvance(said.back, r);
  }
  back = plannerOpenScores(back, plannerDraftsOf(back, r));
  back = plannerAdvance(back, r);
  back = plannerAdvance(
    plannerAddAnswer(back, r, "Did I rest on Saturday?").back,
    r,
  );
  return plannerAdvance(plannerAddAnswer(back, r, "Continue.").back, r);
}

/** The owner answers and the coach acknowledges, as the page runs it with a model. */
function answerWithAck(
  back: PlannerBackState,
  r: PlannerReviewResponse,
  text: string,
): PlannerBackState {
  const { back: said, reply } = plannerAddAnswer(back, r, text);
  expect(reply).toBe("coach");
  return plannerAddCoachReply(said, "Noted.", true);
}

// ---------------------------------------------------------------------------

describe("the page's own drafts", () => {
  it("recaps the week's goals with their objectives, or says none were set", () => {
    expect(plannerFallbackRecap(review())).toBe("No weekly goals were set.");
    expect(plannerFallbackRecap(review({ week_goals: [goal()] }))).toBe(
      "1 weekly goal: Work: Ship the billing page.",
    );
    expect(
      plannerFallbackRecap(
        review({
          week_goals: [
            goal({
              pillar: "health",
              title: " ",
              lines: [{ text: "Run 3x" }, { text: "Sleep by 11" }],
            }),
            goal({ pillar: null, title: "Read one book" }),
          ],
        }),
      ),
    ).toBe("2 weekly goals: Health: Run 3x · Sleep by 11; Read one book.");
  });

  it("starts the scores from the week's own record, else the latest scored week before it, else the floors", () => {
    const history = [
      { week_start: "2026-09-21", auth: 3.5, ach: 4 },
      { week_start: LAST_WEEK, auth: null, ach: null },
      // The week looked back on is never its own starting point.
      { week_start: REVIEW_WEEK, auth: 5, ach: 5 },
    ];
    const scoresOf = (r: PlannerReviewResponse) => {
      const { auth, ach } = plannerFallbackDrafts(r).scores;
      return { auth, ach };
    };
    expect(scoresOf(review({ scores: history }))).toEqual({
      auth: 3.5,
      ach: 4,
    });
    expect(
      scoresOf(
        review({
          scores: history,
          week: weekRecord({ auth: 3, ach: 2.5 }),
        }),
      ),
    ).toEqual({ auth: 3, ach: 2.5 });
    // A record with only one score is not a starting point.
    expect(
      scoresOf(review({ scores: history, week: weekRecord({ auth: 3 }) })),
    ).toEqual({ auth: 3.5, ach: 4 });
    expect(scoresOf(review())).toEqual({ auth: 4, ach: 3.5 });
  });

  it("offers Yes, Partly and No for last week's question, no prompt options and plain verdicts", () => {
    const drafts = plannerFallbackDrafts(review());
    expect(drafts.lastq).toEqual(["Yes", "Partly", "No"]);
    expect(drafts.prompts).toEqual([[], [], [], [], [], [], []]);
    expect(drafts.scores).toMatchObject({
      auth_evidence: "",
      ach_evidence: "",
    });
    expect(drafts.trajectory).toEqual({
      pattern: "",
      risk: "",
      opportunity: "",
      questions: [],
      verdicts: { continue: "Continue.", pivot: "Pivot.", pause: "Pause." },
      recommended: null,
    });
  });

  it("offers last week's question again as next Sunday's, when there was one", () => {
    const drafts = plannerFallbackDrafts(
      review({ last_question: "Did I send the invoices?" }),
    );
    expect(drafts.trajectory.questions).toEqual(["Did I send the invoices?"]);
  });

  it("uses the page's drafts until the model's are in", () => {
    const r = review();
    expect(plannerDraftsOf(plannerNewBackState(r), r)).toEqual(
      plannerFallbackDrafts(r),
    );
    const drafts = plannerMergeOpening(plannerFallbackDrafts(r), opening());
    expect(plannerDraftsOf({ drafts }, r)).toBe(drafts);
  });
});

describe("the model's drafts over the page's", () => {
  const base = plannerFallbackDrafts(review());

  it("takes the model's recap and its options where it gave at least two, three at most", () => {
    const merged = plannerMergeOpening(
      base,
      opening({
        recap: "  A busy week.  ",
        lastq: ["Yes", " ", ""],
        prompts: [["A", " B ", "C", "D"], ["Only one"], []],
      }),
    );
    expect(merged.recap).toBe("A busy week.");
    expect(merged.lastq).toEqual(["Yes", "Partly", "No"]);
    expect(merged.prompts).toEqual([["A", "B", "C"], [], [], [], [], [], []]);
    // The rest is the page's.
    expect(merged.scores).toEqual(base.scores);
    expect(merged.trajectory).toEqual(base.trajectory);
  });

  it("keeps the page's drafts when the model did not answer or answered blank", () => {
    expect(plannerMergeOpening(base, null)).toBe(base);
    expect(plannerMergeOpening(base, opening({ recap: "  " })).recap).toBe(
      "No weekly goals were set.",
    );
    expect(plannerMergeClose(base, null)).toBe(base);
  });

  it("snaps the model's scores to half steps and keeps the drafts' for anything off the scale", () => {
    const snapped = plannerMergeClose(
      base,
      close({ scores: { auth: 4.3, ach: null } }),
    );
    expect(snapped.scores).toMatchObject({ auth: 4.5, ach: 3.5 });
    expect(
      plannerMergeClose(base, close({ scores: { auth: 7, ach: 0 } })).scores,
    ).toMatchObject({ auth: 4, ach: 3.5 });
  });

  it("fills the trajectory, questions and verdicts from the model, keeping the page's where it wrote nothing", () => {
    const merged = plannerMergeClose(
      base,
      close({
        scores: { auth_evidence: "  ", ach_evidence: " Most goals met. " },
        trajectory: {
          pattern: "  ",
          questions: ["  ", "Did I call both leads?"],
          verdicts: {
            continue: "",
            pivot: "Pivot toward sales.",
            pause: "  ",
          },
          recommended: null,
        },
      }),
    );
    expect(merged.scores).toMatchObject({
      auth_evidence: "",
      ach_evidence: "Most goals met.",
    });
    expect(merged.trajectory).toEqual({
      pattern: "",
      risk: "The invoices slip a third week.",
      opportunity: "Two warm leads from the beta.",
      questions: ["Did I call both leads?"],
      verdicts: {
        continue: "Continue.",
        pivot: "Pivot toward sales.",
        pause: "Pause.",
      },
      recommended: null,
    });
    expect(
      plannerMergeClose(base, close({ trajectory: { questions: [" "] } }))
        .trajectory.questions,
    ).toEqual([]);
    expect(plannerMergeClose(base, close()).trajectory.recommended).toBe(
      "pivot",
    );
  });
});

describe("walking through Look back", () => {
  it("goes from the start to done: last week's question and goals, the seven prompts, scores, question and verdict", () => {
    const work = goal({ pillar: "work", title: "Ship the billing page" });
    const health = goal({ pillar: "health", title: "Run three times" });
    const r = review({
      last_question: "Did I send the invoices?",
      week_goals: [work, health],
      scores: [{ week_start: LAST_WEEK, auth: 4, ach: 3.5 }],
    });

    let back = plannerNewBackState(r);
    expect(back.stage).toBe("start");
    // Start: the page drafts while the model writes the options.
    back = { ...back, stage: "drafting" };
    back = plannerOpenQuestions(
      back,
      r,
      plannerMergeOpening(plannerFallbackDrafts(r), opening()),
    );
    expect(back.stage).toBe("lastq");
    expect(back.scores).toEqual({ auth: 4, ach: 3.5 });

    // Last week's question: an answer, one probe, a second answer, then on.
    let turn = plannerAddAnswer(back, r, "Partly");
    expect(turn.reply).toBe("coach");
    expect(plannerCoachMode(turn.back)).toBe("free");
    back = plannerAddProbe(
      plannerAddCoachReply(turn.back, "Which ones are still open?", false),
    );
    turn = plannerAddAnswer(back, r, "Two of five, both waiting on a PO.");
    expect(plannerCoachMode(turn.back)).toBe("force");
    back = plannerAdvance(
      plannerAddCoachReply(turn.back, "Clear. On to your goals.", true),
      r,
    );
    expect(back.stage).toBe("goals");

    // Last week's goals: the owner gives each its result.
    back = {
      ...back,
      goalResults: {
        ...back.goalResults,
        [work.id]: "met",
        [health.id]: "partial",
      },
    };
    back = plannerAdvance(back, r);
    expect(back).toMatchObject({ stage: "p", pi: 0 });

    // The seven prompts: an answer each, which the coach acknowledges.
    for (const [index, prompt] of plannerReviewPrompts.entries()) {
      expect(back).toMatchObject({ stage: "p", pi: index });
      back = answerWithAck(back, r, `${prompt.label} answer`);
      back = plannerAdvance(back, r);
    }
    expect(back.stage).toBe("scoring");

    // The scores are drafted; the owner raises Achievement and keeps them.
    back = plannerOpenScores(
      back,
      plannerMergeClose(plannerDraftsOf(back, r), close()),
    );
    expect(back).toMatchObject({
      stage: "scores",
      scores: { auth: 4.5, ach: 3 },
    });
    back = { ...back, scores: { auth: 4.5, ach: plannerStepScore(3, 0.5) } };
    back = plannerAdvance(back, r);
    expect(back.stage).toBe("question");

    turn = plannerAddAnswer(back, r, "Did I send the invoices on Monday?");
    expect(turn.reply).toBe("advance");
    back = plannerAdvance(turn.back, r);
    expect(back.stage).toBe("verdict");

    turn = plannerAddAnswer(
      back,
      r,
      "Pivot toward sales, away from features. Two leads went cold.",
    );
    expect(turn.reply).toBe("advance");
    back = plannerAdvance(turn.back, r);
    expect(back.stage).toBe("done");

    // The chat, in the order it was shown.
    expect(back.log.map((entry) => entry.k)).toEqual([
      "recap",
      "lastq",
      "user",
      "coach",
      "user",
      "coach",
      "goals",
      ...plannerReviewPrompts.flatMap(() => ["prompt", "user", "coach"]),
      "scores",
      "question",
      "user",
      "verdict",
      "user",
      "done",
    ]);
    expect(
      back.log.flatMap((entry) => (entry.k === "prompt" ? [entry.i] : [])),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    // What it recorded.
    expect(back.lastAnswer).toEqual([
      "Partly",
      "Two of five, both waiting on a PO.",
    ]);
    expect(back.lastProbes).toBe(1);
    expect(back.answers).toEqual(
      plannerReviewPrompts.map((prompt) => [`${prompt.label} answer`]),
    );
    expect(back.probes).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(back.scores).toEqual({ auth: 4.5, ach: 3.5 });
    expect(back.question).toBe("Did I send the invoices on Monday?");
    expect(back.verdict).toEqual({
      kind: "pivot",
      text: "Pivot toward sales, away from features. Two leads went cold.",
    });
    // The coach read every turn, its own with their control lines.
    expect(back.conv.slice(0, 5)).toEqual([
      {
        role: "user",
        content: `[Last week's key question: "Did I send the invoices?"]\nPartly`,
      },
      {
        role: "assistant",
        content: 'Which ones are still open?\n@@ {"advance": false}',
      },
      { role: "user", content: "Two of five, both waiting on a PO." },
      {
        role: "assistant",
        content: 'Clear. On to your goals.\n@@ {"advance": true}',
      },
      {
        role: "user",
        content:
          "[Prompt 1 of 7: What did you accomplish that directly impacts your main goals?]\nImpact answer",
      },
    ]);
    expect(back.conv.slice(-2)).toEqual([
      {
        role: "user",
        content:
          "[Question for next Sunday] Did I send the invoices on Monday?",
      },
      {
        role: "user",
        content:
          "[Verdict] Pivot toward sales, away from features. Two leads went cold.",
      },
    ]);

    // It ends in a save the server accepts.
    const memo = plannerComposeSummaryMemo(plannerSummaryInput(back, r, TODAY));
    const save = plannerLookBackInput(back, r, TODAY, memo);
    expect(plannerLookBackSchema.safeParse(save).error).toBeUndefined();
    expect(save).toMatchObject({
      today: TODAY,
      scores: { auth: 4.5, ach: 3.5 },
      question: "Did I send the invoices on Monday?",
      verdict: { kind: "pivot" },
      goal_results: [
        { goal_id: work.id, result: "met" },
        { goal_id: health.id, result: "partial" },
      ],
    });
  });

  it("runs to the end on the page's own drafts when there is no model", () => {
    const r = review({
      ai: false,
      scores: [{ week_start: LAST_WEEK, auth: 3.5, ach: 3 }],
    });
    let back = plannerSysOnce(
      { ...plannerNewBackState(r), stage: "drafting" },
      "No model connected",
    );
    back = plannerOpenQuestions(
      back,
      r,
      plannerMergeOpening(plannerFallbackDrafts(r), null),
    );
    // Nothing to ask about last week: straight to the first prompt.
    expect(back).toMatchObject({ stage: "p", pi: 0 });
    // Without a model an answer moves straight on; the fourth is skipped.
    for (const [index, prompt] of plannerReviewPrompts.entries()) {
      if (index !== 3) {
        back = plannerAddAnswer(back, r, `${prompt.label} answer`).back;
      }
      back = plannerAdvance(back, r);
    }
    expect(back.stage).toBe("scoring");
    back = plannerOpenScores(
      back,
      plannerMergeClose(plannerDraftsOf(back, r), null),
    );
    // The steppers start from the last scored week.
    expect(back.scores).toEqual({ auth: 3.5, ach: 3 });
    back = plannerAdvance(back, r);
    back = plannerAdvance(
      plannerAddAnswer(back, r, "Did I rest on Saturday?").back,
      r,
    );
    expect(plannerDraftsOf(back, r).trajectory.verdicts).toEqual({
      continue: "Continue.",
      pivot: "Pivot.",
      pause: "Pause.",
    });
    back = plannerAdvance(plannerAddAnswer(back, r, "Pause.").back, r);
    expect(back.stage).toBe("done");
    expect(back.verdict).toEqual({ kind: "pause", text: "Pause." });
    expect(back.answers[3]).toEqual([]);
    expect(back.log.filter((entry) => entry.k === "sys")).toEqual([
      { k: "sys", text: "No model connected" },
    ]);

    const memo = plannerComposeSummaryMemo(plannerSummaryInput(back, r, TODAY));
    expect(memo).toContain("- **Bottleneck:** Skipped.");
    const save = plannerLookBackInput(back, r, TODAY, memo);
    expect(plannerLookBackSchema.safeParse(save).error).toBeUndefined();
    expect(save?.scores).toEqual({ auth: 3.5, ach: 3 });
  });

  it("skips last week's question and goals when there is nothing to ask", () => {
    const plain = review();
    expect(opened(plain).log).toEqual([{ k: "recap" }, { k: "prompt", i: 0 }]);

    const withGoals = review({ week_goals: [goal()] });
    expect(opened(withGoals)).toMatchObject({
      stage: "goals",
      log: [{ k: "recap" }, { k: "goals" }],
    });

    const withQuestion = review({ last_question: "Did I rest?" });
    const lastq = opened(withQuestion);
    expect(lastq.stage).toBe("lastq");
    expect(plannerAdvance(lastq, withQuestion)).toMatchObject({
      stage: "p",
      pi: 0,
    });
  });

  it("lets a prompt be skipped without an answer", () => {
    const r = review();
    const skipped = plannerAdvance(atPrompt(2, r), r);
    expect(skipped).toMatchObject({ stage: "p", pi: 3 });
    expect(skipped.answers[2]).toEqual([]);
    expect(skipped.log.at(-1)).toEqual({ k: "prompt", i: 3 });
  });

  it("stays put where the owner cannot move Look back on", () => {
    const r = review();
    const fresh = plannerNewBackState(r);
    for (const back of [
      fresh,
      { ...fresh, stage: "drafting" as const },
      plannerAdvance(atPrompt(6, r), r),
      finished(r),
    ]) {
      expect(plannerAdvance(back, r)).toBe(back);
    }
  });

  it("opens the score card with the drafted scores", () => {
    const r = review();
    const scoring = plannerAdvance(atPrompt(6, r), r);
    expect(scoring.stage).toBe("scoring");
    const drafts = plannerMergeClose(plannerDraftsOf(scoring, r), close());
    const scores = plannerOpenScores(scoring, drafts);
    expect(scores).toMatchObject({
      stage: "scores",
      drafts,
      scores: { auth: 4.5, ach: 3 },
    });
    expect(scores.log.at(-1)).toEqual({ k: "scores" });
  });

  it("tells whether Look back has moved past a stage", () => {
    expect(plannerPastStage({ stage: "p" }, "goals")).toBe(true);
    expect(plannerPastStage({ stage: "goals" }, "goals")).toBe(false);
    expect(plannerPastStage({ stage: "lastq" }, "goals")).toBe(false);
    expect(plannerPastStage({ stage: "done" }, "scores")).toBe(true);
    expect(plannerPastStage({ stage: "start" }, "start")).toBe(false);
  });

  it("says a note from the page only once", () => {
    const noted = plannerSysOnce(
      atPrompt(0),
      "Model unavailable · page drafts",
    );
    expect(plannerSysOnce(noted, "Model unavailable · page drafts")).toBe(
      noted,
    );
    expect(
      plannerSysOnce(noted, "The model hit a limit").log.filter(
        (entry) => entry.k === "sys",
      ),
    ).toHaveLength(2);
  });

  it("starts each of last week's goals with the result it already has", () => {
    const met = goal({ result: "met" });
    const open = goal();
    const back = plannerNewBackState(review({ week_goals: [met, open] }));
    expect(back).toMatchObject({
      stage: "start",
      pi: 0,
      lastAnswer: [],
      lastProbes: 0,
      log: [],
      conv: [],
      drafts: null,
      scores: null,
      question: null,
      verdict: null,
      memo: null,
      memoBy: null,
      memoStopped: false,
      memoSaved: false,
    });
    expect(back.goalResults).toEqual({ [met.id]: "met", [open.id]: null });
    expect(back.answers).toEqual([[], [], [], [], [], [], []]);
    expect(back.probes).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("plannerAddAnswer", () => {
  it("records an answer in the chat, the prompt's answers and the coach's history, naming the prompt once", () => {
    const r = review();
    const first = plannerAddAnswer(
      atPrompt(2, r),
      r,
      "  Invoicing, still by hand.  ",
    );
    expect(first.reply).toBe("coach");
    expect(first.back.answers[2]).toEqual(["Invoicing, still by hand."]);
    expect(first.back.log.at(-1)).toEqual({
      k: "user",
      text: "Invoicing, still by hand.",
    });
    expect(first.back.conv).toEqual([
      {
        role: "user",
        content:
          "[Prompt 3 of 7: What are you not delegating, automating or pruning?]\nInvoicing, still by hand.",
      },
    ]);
    const second = plannerAddAnswer(first.back, r, "And the weekly report.");
    expect(second.back.answers[2]).toEqual([
      "Invoicing, still by hand.",
      "And the weekly report.",
    ]);
    expect(second.back.conv.at(-1)).toEqual({
      role: "user",
      content: "And the weekly report.",
    });
  });

  it("keeps an answer to 4000 characters, trimmed", () => {
    const r = review();
    expect(
      plannerAddAnswer(atPrompt(0, r), r, "x".repeat(5000)).back.answers[0],
    ).toEqual(["x".repeat(4000)]);
    // Cut at 4000, the space it ends on goes too.
    expect(
      plannerAddAnswer(
        atPrompt(0, r),
        r,
        `   ${"a".repeat(3999)} ${"b".repeat(10)}`,
      ).back.answers[0],
    ).toEqual(["a".repeat(3999)]);
  });

  it("takes at most 12 answers to one prompt, and ignores more", () => {
    const r = review();
    let back = atPrompt(4, r);
    for (let count = 1; count <= 12; count += 1) {
      const turn = plannerAddAnswer(back, r, `Answer ${count}`);
      expect(turn.reply).toBe("coach");
      back = turn.back;
    }
    const thirteenth = plannerAddAnswer(back, r, "One more");
    expect(thirteenth.reply).toBe("none");
    expect(thirteenth.back).toBe(back);
    expect(back.answers[4]).toHaveLength(12);
    // The next prompt has twelve of its own.
    expect(plannerAddAnswer(plannerAdvance(back, r), r, "Next").reply).toBe(
      "coach",
    );
  });

  it("takes at most 12 answers to last week's question", () => {
    const r = review({ last_question: "Did I rest?" });
    let back = opened(r);
    for (let count = 1; count <= 12; count += 1) {
      back = plannerAddAnswer(back, r, `Answer ${count}`).back;
    }
    expect(back.lastAnswer).toHaveLength(12);
    const more = plannerAddAnswer(back, r, "One more");
    expect(more.reply).toBe("none");
    expect(more.back).toBe(back);
  });

  it("ignores a blank answer, and one given where there is nothing to answer", () => {
    const r = review({ week_goals: [goal()] });
    const fresh = plannerNewBackState(r);
    const goalsCard = opened(r);
    expect(goalsCard.stage).toBe("goals");
    for (const back of [
      fresh,
      { ...fresh, stage: "drafting" as const },
      goalsCard,
      plannerAdvance(atPrompt(6, r), r),
    ]) {
      const turn = plannerAddAnswer(back, r, "Hello?");
      expect(turn.reply, back.stage).toBe("none");
      expect(turn.back).toBe(back);
    }
    const blank = atPrompt(0, r);
    expect(plannerAddAnswer(blank, r, "  \n\t ")).toEqual({
      back: blank,
      reply: "none",
    });
  });

  it("takes the question for next Sunday and the verdict, and moves on after each", () => {
    const r = review();
    const question = plannerAddAnswer(
      atQuestion(r),
      r,
      "  Did I call both leads?  ",
    );
    expect(question.reply).toBe("advance");
    expect(question.back.question).toBe("Did I call both leads?");
    expect(question.back.conv.at(-1)).toEqual({
      role: "user",
      content: "[Question for next Sunday] Did I call both leads?",
    });

    const verdict = plannerAddAnswer(
      atVerdict(r),
      r,
      "Pause for pricing. The page can wait.",
    );
    expect(verdict.reply).toBe("advance");
    expect(verdict.back.verdict).toEqual({
      kind: "pause",
      text: "Pause for pricing. The page can wait.",
    });
    expect(verdict.back.conv.at(-1)?.content).toBe(
      "[Verdict] Pause for pricing. The page can wait.",
    );
  });

  it("keeps the question to 500 characters and the verdict to 1000", () => {
    const r = review();
    expect(
      plannerAddAnswer(atQuestion(r), r, "q".repeat(800)).back.question,
    ).toHaveLength(500);
    expect(
      plannerAddAnswer(atVerdict(r), r, `Pivot ${"v".repeat(1500)}`).back
        .verdict,
    ).toEqual({ kind: "pivot", text: `Pivot ${"v".repeat(994)}` });
  });

  it("chats on the score card and after the prompts, telling the coach where the owner is", () => {
    const r = review();
    const turn = plannerAddAnswer(
      atScores(r),
      r,
      "Why not a 4 on achievement?",
    );
    expect(turn.reply).toBe("chat");
    expect(turn.back.log.at(-1)).toEqual({
      k: "user",
      text: "Why not a 4 on achievement?",
    });
    expect(turn.back.conv.at(-1)).toEqual({
      role: "user",
      content:
        "[Scores step, draft Authenticity 4.0, Achievement 3.5] Why not a 4 on achievement?",
    });
    const after = plannerAddAnswer(finished(r), r, "Thanks.");
    expect(after.reply).toBe("chat");
    expect(after.back.conv.at(-1)).toEqual({
      role: "user",
      content: "[After the prompts] Thanks.",
    });
  });
});

describe("the coach", () => {
  it("may probe once on a prompt, then acknowledges and moves on", () => {
    for (const pi of [0, 1, 2, 3, 4, 6]) {
      let back = atPrompt(pi);
      expect(plannerCoachMode(back), `prompt ${pi + 1}`).toBe("free");
      back = plannerAddProbe(back);
      expect(back.probes[pi]).toBe(1);
      expect(plannerCoachMode(back), `prompt ${pi + 1}`).toBe("force");
    }
  });

  it("may probe twice on the blindspot, the sixth prompt", () => {
    expect(plannerReviewPrompts[5].label).toBe("Blindspot");
    let back = atPrompt(5);
    expect(plannerCoachMode(back)).toBe("free");
    back = plannerAddProbe(back);
    expect(plannerCoachMode(back)).toBe("free");
    back = plannerAddProbe(back);
    expect(back.probes).toEqual([0, 0, 0, 0, 0, 2, 0]);
    expect(plannerCoachMode(back)).toBe("force");
  });

  it("counts each prompt's probes on their own", () => {
    const r = review();
    const probed = plannerAddProbe(atPrompt(1, r));
    expect(plannerCoachMode(probed)).toBe("force");
    const next = plannerAdvance(probed, r);
    expect(next.pi).toBe(2);
    expect(plannerCoachMode(next)).toBe("free");
  });

  it("may probe once on last week's question", () => {
    let back = opened(review({ last_question: "Did I rest?" }));
    expect(plannerCoachMode(back)).toBe("free");
    back = plannerAddProbe(back);
    expect(back.lastProbes).toBe(1);
    expect(back.probes).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(plannerCoachMode(back)).toBe("force");
  });

  it("only chats once the prompts are behind it, and counts no probes there", () => {
    const scores = atScores();
    expect(plannerCoachMode(scores)).toBe("chat");
    expect(plannerCoachMode(finished())).toBe("chat");
    expect(plannerAddProbe(scores)).toBe(scores);
  });

  it("puts the coach's reply in the chat and keeps its control line in the history it reads", () => {
    const back = plannerAddCoachReply(
      atPrompt(0),
      "  What exactly shipped?  ",
      false,
    );
    expect(back.log.at(-1)).toEqual({
      k: "coach",
      text: "What exactly shipped?",
    });
    expect(back.conv.at(-1)).toEqual({
      role: "assistant",
      content: 'What exactly shipped?\n@@ {"advance": false}',
    });
    expect(plannerAddCoachReply(back, "Good.", true).conv.at(-1)?.content).toBe(
      'Good.\n@@ {"advance": true}',
    );
  });

  it("ignores an empty reply", () => {
    const back = atPrompt(0);
    expect(plannerAddCoachReply(back, " \n ", true)).toBe(back);
  });

  it("reads the last 40 turns of the chat, starting with one of the owner's", () => {
    const conv: PlannerReviewChatMessage[] = Array.from(
      { length: 45 },
      (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `Turn ${index}`,
      }),
    );
    const messages = plannerCoachMessages({ conv });
    // The last 40 start with turn 5, the coach's own; it reads from turn 6.
    expect(messages).toHaveLength(39);
    expect(messages[0]).toEqual({ role: "user", content: "Turn 6" });
    expect(messages.at(-1)).toEqual({ role: "user", content: "Turn 44" });
  });

  it("never sends an empty turn, and keeps each to 8000 characters", () => {
    expect(
      plannerCoachMessages({
        conv: [
          { role: "user", content: "   " },
          { role: "assistant", content: `  ${"y".repeat(9000)}` },
        ],
      }),
    ).toEqual([
      { role: "user", content: "…" },
      { role: "assistant", content: "y".repeat(8000) },
    ]);
  });

  it("builds a request the coach's route accepts from a real chat", () => {
    const r = review({ last_question: 'Did I say "no" to the extra project?' });
    let back = plannerAddAnswer(opened(r), r, "Mostly.").back;
    back = plannerAddProbe(
      plannerAddCoachReply(back, "What did you say yes to?", false),
    );
    back = plannerAddAnswer(back, r, "The partner call.").back;
    const request = {
      today: TODAY,
      mode: plannerCoachMode(back),
      messages: plannerCoachMessages(back),
    };
    expect(request.mode).toBe("force");
    expect(request.messages[0]?.content).toBe(
      '[Last week\'s key question: "Did I say "no" to the extra project?"]\nMostly.',
    );
    expect(plannerAiCoachSchema.safeParse(request).error).toBeUndefined();
  });

  it("reads the verdict's kind from the word it starts with", () => {
    expect(
      plannerVerdictKindOf("Pivot toward sales, away from features."),
    ).toBe("pivot");
    expect(plannerVerdictKindOf("  pause for pricing.")).toBe("pause");
    expect(plannerVerdictKindOf("PAUSE.")).toBe("pause");
    expect(plannerVerdictKindOf("Continue. The cadence holds.")).toBe(
      "continue",
    );
    // Anything else, or nothing, continues.
    expect(plannerVerdictKindOf("Keep going as planned.")).toBe("continue");
    expect(plannerVerdictKindOf("")).toBe("continue");
  });

  it("does not take a verdict that starts with another word, like Pivotal, for a pivot", () => {
    expect(
      plannerVerdictKindOf("Pivotal week, but the plan holds. Continue."),
    ).toBe("continue");
    expect(plannerVerdictKindOf("Pausable work only.")).toBe("continue");
    // Forms of the word itself still count.
    expect(plannerVerdictKindOf("Pivoting to sales.")).toBe("pivot");
    expect(plannerVerdictKindOf("Paused: pricing first.")).toBe("pause");
  });

  it("reads a verdict written in Chinese", () => {
    expect(plannerVerdictKindOf("转向销售，离开新功能。")).toBe("pivot");
    expect(plannerVerdictKindOf(" 暂停，先定价格。")).toBe("pause");
    expect(plannerVerdictKindOf("继续。节奏稳定。")).toBe("continue");
  });

  it("moves a score by half steps and keeps it between 1 and 5", () => {
    expect(plannerStepScore(4, 0.5)).toBe(4.5);
    expect(plannerStepScore(4, -0.5)).toBe(3.5);
    expect(plannerStepScore(5, 0.5)).toBe(5);
    expect(plannerStepScore(1, -0.5)).toBe(1);
    // A score off the half steps lands on the nearest one.
    expect(plannerStepScore(3.3, 0)).toBe(3.5);
  });
});

describe("what Look back sends", () => {
  it("sends the answers and the coach's last 20 notes, within the close's limits", () => {
    const r = review({ last_question: "Did I rest?" });
    let back = plannerAddAnswer(opened(r), r, "Yes").back;
    for (let index = 1; index <= 25; index += 1) {
      back = plannerAddCoachReply(back, `Note ${index}`, true);
    }
    back = plannerAddCoachReply(back, "n".repeat(2500), true);
    const input = plannerAnswersInput(back, r);
    expect(input.last_answer).toEqual(["Yes"]);
    expect(input.answers).toEqual([[], [], [], [], [], [], []]);
    expect(input.coach_notes).toHaveLength(20);
    expect(input.coach_notes[0]).toBe("Note 7");
    expect(input.coach_notes.at(-1)).toBe("n".repeat(2000));
    expect(
      plannerAiCloseSchema.safeParse({ today: TODAY, ...input }).error,
    ).toBeUndefined();
  });

  it("keeps the answers it sends within the limits, whatever a saved state holds", () => {
    const r = review();
    const back: PlannerBackState = {
      ...atPrompt(0, r),
      lastAnswer: ["  ", "ok"],
      answers: plannerReviewPrompts.map(() =>
        Array.from({ length: 15 }, () => "z".repeat(5000)),
      ),
    };
    const input = plannerAnswersInput(back, r);
    expect(input.last_answer).toEqual(["ok"]);
    for (const list of input.answers) {
      expect(list).toHaveLength(12);
      expect(list.every((answer) => answer.length === 4000)).toBe(true);
    }
    expect(
      plannerAiCloseSchema.safeParse({ today: TODAY, ...input }).error,
    ).toBeUndefined();
  });

  it("sends each of the week's goals with its result, at most 24, and none for a value that is not a result", () => {
    const met = goal({ result: "met" });
    const open = goal();
    const odd = goal();
    const r = review({ week_goals: [met, open, odd] });
    const back = {
      goalResults: {
        [met.id]: "met",
        [odd.id]: "great",
      } as unknown as PlannerBackState["goalResults"],
    };
    expect(plannerGoalResultsInput(back, r)).toEqual([
      { goal_id: met.id, result: "met" },
      { goal_id: open.id, result: null },
      { goal_id: odd.id, result: null },
    ]);
    const many = review({
      week_goals: Array.from({ length: 30 }, () => goal()),
    });
    expect(
      plannerGoalResultsInput(plannerNewBackState(many), many),
    ).toHaveLength(24);
  });

  it("keeps the memo's drafts to 1000 characters each", () => {
    const drafts = plannerMergeClose(
      plannerFallbackDrafts(review()),
      close({
        scores: { auth_evidence: `${"e".repeat(1200)}` },
        trajectory: { pattern: "  Admin slips.  " },
      }),
    );
    expect(plannerMemoDrafts(drafts)).toEqual({
      auth_evidence: "e".repeat(1000),
      ach_evidence: "The beta shipped; the invoices slipped.",
      pattern: "Admin slips.",
      risk: "The invoices slip a third week.",
      opportunity: "Two warm leads from the beta.",
    });
  });

  it("builds a memo request the server accepts, as the page does", () => {
    const r = review({
      last_question: "Did I rest?",
      week_goals: [goal({ result: "met" })],
    });
    const back = finished(r);
    const drafts = plannerDraftsOf(back, r);
    const request = {
      today: TODAY,
      ...plannerAnswersInput(back, r),
      scores: back.scores,
      question: back.question,
      verdict: back.verdict,
      recommended: drafts.trajectory.recommended ?? "continue",
      drafts: plannerMemoDrafts(drafts),
    };
    expect(plannerAiMemoSchema.safeParse(request).error).toBeUndefined();
  });

  it("hands the memo template everything the review recorded", () => {
    const work = goal({ pillar: "work", title: "Ship the billing page" });
    const r = review({ last_question: "Did I rest?", week_goals: [work] });
    const back: PlannerBackState = {
      ...finished(r),
      goalResults: { [work.id]: "met" },
    };
    const input = plannerSummaryInput(back, r, TODAY);
    expect(input).toMatchObject({
      weekStart: REVIEW_WEEK,
      reviewedOn: TODAY,
      recap: "1 weekly goal: Work: Ship the billing page.",
      lastQuestion: "Did I rest?",
      lastAnswer: ["Partly"],
      goals: [
        { pillar: "work", title: "Ship the billing page", result: "met" },
      ],
      scores: { auth: 4, ach: 3.5 },
      question: "Did I rest on Saturday?",
      verdict: { kind: "continue", text: "Continue." },
      recommended: null,
    });
    expect(input.answers[0]).toEqual(["Impact: it went fine"]);
    const memo = plannerComposeSummaryMemo(input);
    expect(memo).toContain("# Week 41: October 5 - October 11, 2026");
    expect(memo).toContain("Ship the billing page: Met.");
    expect(memo).toContain("- **Impact:** Impact: it went fine.");
  });

  it("snaps the scores, trims the question and verdict and leaves out what is blank", () => {
    const r = review();
    const back: PlannerBackState = {
      ...atScores(r),
      scores: { auth: 4.2, ach: 2.8 },
      question: "   ",
      verdict: { kind: "pivot", text: "  " },
    };
    expect(plannerLookBackInput(back, r, TODAY, "  # Memo  ")).toEqual({
      today: TODAY,
      scores: { auth: 4, ach: 3 },
      question: null,
      verdict: null,
      goal_results: [],
      memo: "# Memo",
    });
    const long = plannerLookBackInput(
      {
        ...back,
        question: "q".repeat(600),
        verdict: { kind: "pause", text: "p".repeat(1200) },
      },
      r,
      TODAY,
      "m".repeat(100_500),
    );
    expect(long?.question).toHaveLength(500);
    expect(long?.verdict?.text).toHaveLength(1000);
    expect(long?.memo).toHaveLength(100_000);
    expect(plannerLookBackSchema.safeParse(long).error).toBeUndefined();
  });

  it("has nothing to save without a memo, or with a score off the scale", () => {
    const r = review();
    expect(plannerLookBackInput(atScores(r), r, TODAY, " \n ")).toBeNull();
    expect(
      plannerLookBackInput(
        { ...atScores(r), scores: { auth: 0, ach: 3 } },
        r,
        TODAY,
        "# Memo",
      ),
    ).toBeNull();
  });

  it("saves the drafted scores when the owner never reached the score card", () => {
    const r = review({
      scores: [{ week_start: LAST_WEEK, auth: 3, ach: 4.5 }],
    });
    expect(
      plannerLookBackInput(plannerNewBackState(r), r, TODAY, "# Memo")?.scores,
    ).toEqual({ auth: 3, ach: 4.5 });
  });
});

// ---------------------------------------------------------------------------

const MEMO = [
  "## 3. Goal Progress Update",
  "",
  "### I. Objective Function",
  "- **Next Steps:** Keep the Sunday review under an hour.",
  "",
  "### II. Work",
  "- **Next Steps:** Close two customers.",
  "",
  "### IV. Health & Fitness",
  "- **Next Steps:** None stated.",
].join("\n");

describe("Look forward: the plan's goals", () => {
  it("starts from the goals already saved for the week", () => {
    const saved = [
      goal({ period_start: PLAN_WEEK, title: "Close two customers" }),
      goal({
        period_start: PLAN_WEEK,
        pillar: null,
        title: "",
        lines: [{ text: "Sleep by 11" }, { text: "No phone in bed" }],
      }),
    ];
    const [first, second] = saved;
    expect(
      plannerInitialPlanGoals(
        review({ plan_goals: saved, suggested_goals: { work: "Other" } }),
      ),
    ).toEqual([
      { id: first?.id, pillar: "work", title: "Close two customers" },
      { id: second?.id, pillar: null, title: "Sleep by 11 · No phone in bed" },
    ]);
  });

  it("else starts one goal per objective, filled from the latest summary's Next Steps", () => {
    const goals = plannerInitialPlanGoals(
      review({
        suggested_goals: { work: "  Close two customers  ", health: "   " },
      }),
    );
    expect(
      goals.map(({ pillar, title, fromSummary }) => ({
        pillar,
        title,
        fromSummary,
      })),
    ).toEqual([
      { pillar: "of", title: "", fromSummary: undefined },
      // Before this week's summary is written, the steps are last week's.
      { pillar: "work", title: "Close two customers", fromSummary: LAST_WEEK },
      { pillar: "ai", title: "", fromSummary: undefined },
      { pillar: "health", title: "", fromSummary: undefined },
    ]);
    // Each goal has a UUID of its own, which the server keeps.
    for (const item of goals) expect(item.id).toMatch(UUID);
    expect(new Set(goals.map((item) => item.id)).size).toBe(4);
  });

  it("marks goals filled from this week's summary with this week once it is written", () => {
    const goals = plannerInitialPlanGoals(
      review({
        summary: { id: "memos/summary-41", content: MEMO },
        suggested_goals: { work: "Close two customers." },
      }),
    );
    expect(goals.find((item) => item.pillar === "work")?.fromSummary).toBe(
      REVIEW_WEEK,
    );
  });

  it("opens Look forward unseen, on its first step, with nothing planned", () => {
    const saved = goal({ period_start: PLAN_WEEK });
    const r = review({ plan_goals: [saved] });
    expect(plannerNewForwardState(r)).toEqual({
      seen: false,
      step: 1,
      settled: {},
      goals: [{ id: saved.id, pillar: "work", title: "Ship the billing page" }],
      tasks: [],
      toBacklog: [],
      question: null,
      edited: false,
      prefilled: false,
    });
  });

  it("fills the plan's goals from the memo's Next Steps, dropping the tasks of a goal that changed", () => {
    const of = planGoal({ pillar: "of", title: "" });
    const work = planGoal({ pillar: "work", title: "Old work goal" });
    const ai = planGoal({ pillar: "ai", title: "Try the new model" });
    const health = planGoal({ pillar: "health", title: "Run three times" });
    const kept = [task(ai.id), task(health.id)];
    const plan = forward({
      goals: [of, work, ai, health],
      tasks: [task(work.id), ...kept],
    });
    const next = plannerPlanFromMemo(plan, MEMO, false, REVIEW_WEEK);
    expect(next.goals).toEqual([
      {
        ...of,
        title: "Keep the Sunday review under an hour.",
        fromSummary: REVIEW_WEEK,
      },
      { ...work, title: "Close two customers.", fromSummary: REVIEW_WEEK },
      ai,
      health,
    ]);
    expect(next.tasks).toEqual(kept);
  });

  it("adds a goal for an objective the plan has none for", () => {
    const ai = planGoal({ pillar: "ai", title: "Try the new model" });
    const next = plannerPlanFromMemo(
      forward({ goals: [ai] }),
      MEMO,
      false,
      REVIEW_WEEK,
    );
    expect(next.goals).toEqual([
      ai,
      {
        id: expect.stringMatching(UUID),
        pillar: "of",
        title: "Keep the Sunday review under an hour.",
        fromSummary: REVIEW_WEEK,
      },
      {
        id: expect.stringMatching(UUID),
        pillar: "work",
        title: "Close two customers.",
        fromSummary: REVIEW_WEEK,
      },
    ]);
  });

  it("leaves a plan the owner changed, or one saved before, as it is", () => {
    const goals = [planGoal({ pillar: "work", title: "Mine" })];
    const edited = forward({ goals, edited: true });
    expect(plannerPlanFromMemo(edited, MEMO, false, REVIEW_WEEK)).toBe(edited);
    const saved = forward({ goals });
    expect(plannerPlanFromMemo(saved, MEMO, true, REVIEW_WEEK)).toBe(saved);
  });

  it("leaves the plan alone when the memo's steps are already its goals, or it has none", () => {
    const filled = forward({
      goals: [
        planGoal({
          pillar: "of",
          title: "Keep the Sunday review under an hour.",
        }),
        planGoal({ pillar: "work", title: "Close two customers." }),
      ],
    });
    expect(plannerPlanFromMemo(filled, MEMO, false, REVIEW_WEEK)).toBe(filled);
    // The page's own template points Next Steps to the trajectory.
    const r = review();
    const template = plannerComposeSummaryMemo(
      plannerSummaryInput(finished(r), r, TODAY),
    );
    const plan = forward({ goals: [planGoal({ title: "" })] });
    expect(plannerPlanFromMemo(plan, template, false, REVIEW_WEEK)).toBe(plan);
  });

  it("saves only the goals that have a title", () => {
    const named = planGoal({ title: "Close two customers" });
    expect(
      plannerNamedGoals({
        goals: [planGoal({ title: "" }), named, planGoal({ title: "  " })],
      }),
    ).toEqual([named]);
  });

  it("names goals and new tasks with fresh UUIDs", () => {
    const first = plannerNewId();
    expect(first).toMatch(UUID);
    expect(plannerNewId()).not.toBe(first);
  });
});

describe("Look forward: tasks and the To Do count", () => {
  it("adds the board's cards that already serve a goal of the plan, with their column, once", () => {
    const work = planGoal({ pillar: "work" });
    const health = planGoal({ pillar: "health", title: "Run three times" });
    const todo = card({ goal_id: work.id, title: "Send the proposal" });
    const backlog = card({ goal_id: health.id });
    const doing = card({ goal_id: work.id });
    const done = card({ goal_id: work.id, status: "done" });
    const otherGoal = card({ goal_id: uuid() });
    const loose = card();
    const odd = card({ goal_id: work.id, status: "blocked" });
    const theBoard = board({
      todo: [todo, loose],
      backlog: [backlog],
      doing: [doing],
      done: [done, otherGoal],
      other: [odd],
    });
    const plan = forward({ goals: [work, health], prefilled: false });
    const next = plannerPrefillTasks(plan, theBoard);
    expect(next.prefilled).toBe(true);
    expect(next.edited).toBe(false);
    expect(next.tasks).toEqual([
      {
        ref: `t-${todo.id}`,
        goal_id: work.id,
        task_id: todo.id,
        title: "Send the proposal",
        source: "todo",
      },
      {
        ref: `t-${backlog.id}`,
        goal_id: health.id,
        task_id: backlog.id,
        title: backlog.title,
        source: "backlog",
      },
      {
        ref: `t-${doing.id}`,
        goal_id: work.id,
        task_id: doing.id,
        title: doing.title,
        source: "doing",
      },
      {
        ref: `t-${done.id}`,
        goal_id: work.id,
        task_id: done.id,
        title: done.title,
        source: "done",
      },
    ]);
    // Once is enough: a later board does not add them again.
    expect(plannerPrefillTasks(next, theBoard)).toBe(next);
  });

  it("does not add a card the plan already names", () => {
    const work = planGoal();
    const named = card({ goal_id: work.id });
    const plan = forward({
      goals: [work],
      prefilled: false,
      tasks: [
        {
          ref: "mine",
          goal_id: work.id,
          task_id: named.id,
          title: named.title,
          source: "todo",
        },
      ],
    });
    expect(
      plannerPrefillTasks(plan, board({ todo: [named] })).tasks,
    ).toHaveLength(1);
  });

  it("lists the To Do cards the plan does not name", () => {
    const work = planGoal();
    const named = card();
    const other = card();
    const plan = plannerAddBoardTask(
      forward({ goals: [work] }),
      work.id,
      named,
      "todo",
    );
    expect(plannerOtherTodo(plan, board({ todo: [named, other] }))).toEqual([
      other,
    ]);
  });

  it("counts the To Do cards that stay, plus the new and Backlog tasks that join them", () => {
    const work = planGoal();
    const [a, b, c] = [card(), card(), card()];
    const fromBacklog = card();
    const fromDoing = card();
    const theBoard = board({
      todo: [a, b, c],
      backlog: [fromBacklog],
      doing: [fromDoing],
    });
    let plan = forward({ goals: [work] });
    expect(plannerTodoCount(plan, theBoard)).toBe(3);
    // A To Do card is already counted.
    plan = plannerAddBoardTask(plan, work.id, a, "todo");
    expect(plannerTodoCount(plan, theBoard)).toBe(3);
    plan = plannerAddBoardTask(plan, work.id, fromBacklog, "backlog");
    expect(plannerTodoCount(plan, theBoard)).toBe(4);
    // A Doing card stays in Doing.
    plan = plannerAddBoardTask(plan, work.id, fromDoing, "doing");
    expect(plannerTodoCount(plan, theBoard)).toBe(4);
    plan = plannerAddNewTask(plan, work.id, "Draft the pricing page");
    expect(plannerTodoCount(plan, theBoard)).toBe(5);
    // A card sent back to Backlog leaves.
    plan = { ...plan, toBacklog: [b.id] };
    expect(plannerTodoCount(plan, theBoard)).toBe(4);
  });

  it("does not count the tasks of a goal with no title, which are not saved", () => {
    const blank = planGoal({ title: "" });
    const plan = plannerAddNewTask(
      forward({ goals: [blank] }),
      blank.id,
      "Draft the pricing page",
    );
    expect(plannerTodoCount(plan, board({ todo: [card()] }))).toBe(1);
  });

  it("keeps a To Do card that was sent back to Backlog and then picked in To Do, counted once", () => {
    for (const column of ["todo", "backlog"] as const) {
      const work = planGoal();
      const keep = card();
      const sentBack = card({ title: "Reply to the auditor" });
      const theBoard = board({ todo: [keep, sentBack] });
      // The owner sends it back to Backlog...
      let plan = forward({ goals: [work], toBacklog: [sentBack.id] });
      expect(plannerTodoCount(plan, theBoard)).toBe(1);
      // ...where the picker lists it, and picks it for a goal after all.
      expect(plannerPickableCards(plan, theBoard).backlog).toEqual([sentBack]);
      plan = plannerAddBoardTask(plan, work.id, sentBack, column);
      expect(plan.toBacklog).toEqual([]);
      expect(plan.tasks).toEqual([
        {
          ref: `t-${sentBack.id}`,
          goal_id: work.id,
          task_id: sentBack.id,
          title: "Reply to the auditor",
          source: "todo",
        },
      ]);
      expect(plannerTodoCount(plan, theBoard), column).toBe(2);
      // The save keeps it in To Do.
      expect(plannerCommitInput(plan, "", [], TODAY).to_backlog).toEqual([]);
    }
  });

  it("counts a planned card from where it is on the board now, not from where it was picked", () => {
    const work = planGoal();
    const fromBacklog = card();
    const fromTodo = card();
    let plan = plannerAddBoardTask(
      forward({ goals: [work] }),
      work.id,
      fromBacklog,
      "backlog",
    );
    expect(plannerTodoCount(plan, board({ backlog: [fromBacklog] }))).toBe(1);
    // Moved to To Do on the cockpit since: counted once, as a To Do card.
    expect(plannerTodoCount(plan, board({ todo: [fromBacklog] }))).toBe(1);
    // Moved on to Doing: it does not join To Do.
    expect(plannerTodoCount(plan, board({ doing: [fromBacklog] }))).toBe(0);
    // Gone from the board: nothing to count.
    expect(plannerTodoCount(plan, board())).toBe(0);
    // A To Do card sent to Backlog on the cockpit since joins To Do again.
    plan = plannerAddBoardTask(plan, work.id, fromTodo, "todo");
    expect(
      plannerTodoCount(plan, board({ backlog: [fromBacklog, fromTodo] })),
    ).toBe(2);
  });

  it("names each new task by the task the save made, and puts the Backlog cards it took in To Do", () => {
    const work = planGoal();
    const fromTodo = card();
    const fromBacklog = card();
    const fromDoing = card();
    const sentBack = card();
    let plan = forward({
      goals: [work],
      toBacklog: [sentBack.id],
      settled: { "flag-1": { state: "kept" } },
      edited: true,
    });
    plan = plannerAddBoardTask(plan, work.id, fromTodo, "todo");
    plan = plannerAddBoardTask(plan, work.id, fromBacklog, "backlog");
    plan = plannerAddBoardTask(plan, work.id, fromDoing, "doing");
    plan = plannerAddNewTask(plan, work.id, "Draft the pricing page");
    plan = plannerAddNewTask(plan, work.id, "Book the venue");
    const [, , , drafted, unsaved] = plan.tasks;
    const after = plannerAfterCommit(
      plan,
      plannerCommitInput(plan, "Did I call both leads?", [], TODAY),
      // The server answers for the refs it created, and only those.
      { [drafted?.ref ?? ""]: "tasks/new-1" },
      "Did I call both leads?",
    );
    expect(after).toEqual({
      ...plan,
      question: "Did I call both leads?",
      toBacklog: [],
      tasks: [
        { ...plan.tasks[0], source: "todo" },
        { ...plan.tasks[1], source: "todo" },
        { ...plan.tasks[2], source: "doing" },
        { ...drafted, task_id: "tasks/new-1", source: "todo" },
        { ...unsaved, source: "new" },
      ],
    });
    expect(after.tasks[4]?.task_id).toBeUndefined();
  });

  it("never gives a card the plan already names another task id", () => {
    const work = planGoal();
    const picked = card();
    const plan = plannerAddBoardTask(
      forward({ goals: [work] }),
      work.id,
      picked,
      "todo",
    );
    const ref = plan.tasks[0]?.ref ?? "";
    const after = plannerAfterCommit(
      plan,
      plannerCommitInput(plan, "", [], TODAY),
      { [ref]: "tasks/other" },
      "",
    );
    expect(after.tasks[0]?.task_id).toBe(picked.id);
    expect(after.question).toBe("");
  });

  // A goal with no title is not sent, nor are tasks past the 40 a save takes:
  // their cards stay put, so their labels must too.
  it("leaves a Backlog task the save did not send as it was", () => {
    const work = planGoal();
    const untitled = planGoal({ pillar: "ai", title: "" });
    const sent = card();
    const notSent = card();
    let plan = forward({ goals: [work, untitled] });
    plan = plannerAddBoardTask(plan, work.id, sent, "backlog");
    plan = plannerAddBoardTask(plan, untitled.id, notSent, "backlog");
    expect(plannerCommitInput(plan, "", [], TODAY).tasks).toEqual([
      { ref: `t-${sent.id}`, goal_id: work.id, task_id: sent.id },
    ]);
    const after = plannerAfterCommit(
      plan,
      plannerCommitInput(plan, "", [], TODAY),
      {},
      "",
    );
    expect(after.tasks.map((item) => item.source)).toEqual(["todo", "backlog"]);
  });

  it("does not count the plan twice once it is saved and reopened against the updated board", () => {
    const r = review();
    const work = planGoal();
    const [a, b] = [card(), card()];
    const sentBack = card();
    const fromBacklog = card();
    const fromDoing = card();
    const before = board({
      todo: [a, b, sentBack],
      backlog: [fromBacklog],
      doing: [fromDoing],
    });
    let plan = forward({ goals: [work], toBacklog: [sentBack.id] });
    plan = plannerAddBoardTask(plan, work.id, fromBacklog, "backlog");
    plan = plannerAddBoardTask(plan, work.id, fromDoing, "doing");
    plan = plannerAddNewTask(plan, work.id, "Draft the pricing page");
    // a and b stay, the Backlog card and the new task join.
    expect(plannerTodoCount(plan, before)).toBe(4);

    // The save moves the cards and creates the new task in To Do.
    const sent = plannerCommitInput(plan, "Did I call both leads?", [], TODAY);
    expect(sent.to_backlog).toEqual([sentBack.id]);
    const newRef = plan.tasks[2]?.ref ?? "";
    const made = card({ id: "tasks/new-1", title: "Draft the pricing page" });
    const after = board({
      todo: [a, b, fromBacklog, made],
      backlog: [sentBack],
      doing: [fromDoing],
    });
    const saved = plannerAfterCommit(
      plan,
      sent,
      { [newRef]: made.id },
      "Did I call both leads?",
    );
    expect(plannerTodoCount(saved, after)).toBe(4);

    // Reopened on a later visit, from what the page saved.
    const state = JSON.parse(
      JSON.stringify({ ...plannerNewReviewState(r), forward: saved }),
    ) as unknown;
    const reopened = plannerRestoreReviewState(state, r).forward;
    expect(reopened).toEqual(saved);
    expect(plannerTodoCount(reopened, after)).toBe(4);
    expect(plannerOtherTodo(reopened, after)).toEqual([a, b]);

    // Saving again changes nothing that is already done.
    const again = plannerCommitInput(
      reopened,
      "Did I call both leads?",
      [],
      TODAY,
    );
    expect(again.to_backlog).toEqual([]);
    expect(again.tasks).toEqual([
      { ref: `t-${fromBacklog.id}`, goal_id: work.id, task_id: fromBacklog.id },
      { ref: `t-${fromDoing.id}`, goal_id: work.id, task_id: fromDoing.id },
      { ref: newRef, goal_id: work.id, task_id: made.id },
    ]);
    expect(plannerCommitSchema.safeParse(again).error).toBeUndefined();
  });

  it("offers the cards no goal has yet, To Do cards being sent back listed under Backlog", () => {
    const work = planGoal();
    const named = card();
    const free = card();
    const moved = card();
    const inBacklog = card();
    const inDoing = card();
    const done = card();
    const theBoard = board({
      todo: [named, free, moved],
      backlog: [inBacklog],
      doing: [inDoing],
      done: [done],
    });
    const plan = forward({
      goals: [work],
      toBacklog: [moved.id],
      tasks: [
        {
          ref: `t-${named.id}`,
          goal_id: work.id,
          task_id: named.id,
          title: named.title,
          source: "todo",
        },
      ],
    });
    expect(plannerPickableCards(plan, theBoard)).toEqual({
      todo: [free],
      backlog: [moved, inBacklog],
      doing: [inDoing],
    });
  });

  it("adds a card to one goal only, naming its task by the card within 64 characters", () => {
    const work = planGoal();
    const health = planGoal({ pillar: "health" });
    const picked = card();
    const plan = plannerAddBoardTask(
      forward({ goals: [work, health] }),
      work.id,
      picked,
      "doing",
    );
    expect(plan.edited).toBe(true);
    expect(plan.tasks).toEqual([
      {
        ref: `t-${picked.id}`,
        goal_id: work.id,
        task_id: picked.id,
        title: picked.title,
        source: "doing",
      },
    ]);
    expect(plannerAddBoardTask(plan, health.id, picked, "doing")).toBe(plan);
    const long = card({ id: `tasks/${"x".repeat(100)}` });
    const ref = plannerAddBoardTask(plan, work.id, long, "backlog").tasks.at(
      -1,
    )?.ref;
    expect(ref).toBe(`t-tasks/${"x".repeat(56)}`);
    expect(ref).toHaveLength(64);
  });

  it("adds a new task trimmed, with a ref of its own, and ignores a blank one", () => {
    const work = planGoal();
    const plan = forward({ goals: [work] });
    expect(plannerAddNewTask(plan, work.id, "   ")).toBe(plan);
    const one = plannerAddNewTask(plan, work.id, "  Draft the pricing page  ");
    const two = plannerAddNewTask(one, work.id, "Draft the pricing page");
    expect(two.edited).toBe(true);
    expect(two.tasks).toEqual([
      {
        ref: expect.stringMatching(UUID),
        goal_id: work.id,
        title: "Draft the pricing page",
        source: "new",
      },
      {
        ref: expect.stringMatching(UUID),
        goal_id: work.id,
        title: "Draft the pricing page",
        source: "new",
      },
    ]);
    expect(two.tasks[0]?.ref).not.toBe(two.tasks[1]?.ref);
    expect(
      plannerAddNewTask(plan, work.id, "t".repeat(2500)).tasks[0]?.title,
    ).toHaveLength(2000);
  });
});

describe("Look forward: the check and the save", () => {
  it("asks the next review the plan's question, else Look back's, else the week's saved one", () => {
    const r = review({ week: weekRecord({ question: "Saved?" }) });
    expect(
      plannerPlanQuestion({ question: "Plan?" }, { question: "Back?" }, r),
    ).toBe("Plan?");
    expect(
      plannerPlanQuestion({ question: null }, { question: "Back?" }, r),
    ).toBe("Back?");
    expect(plannerPlanQuestion({ question: null }, { question: null }, r)).toBe(
      "Saved?",
    );
    expect(
      plannerPlanQuestion({ question: null }, { question: null }, review()),
    ).toBe("");
    // A question the owner cleared stays cleared.
    expect(
      plannerPlanQuestion({ question: "" }, { question: "Back?" }, r),
    ).toBe("");
  });

  it("checks the named goals with their tasks, within the check's limits", () => {
    const goals = Array.from({ length: 14 }, (_, index) =>
      planGoal({ title: `  Goal ${index + 1}  ` }),
    );
    const [first, second] = goals;
    if (!first || !second) throw new Error("No goals.");
    const blank = planGoal({ title: "  " });
    const plan = forward({
      goals: [blank, ...goals],
      tasks: [
        ...Array.from({ length: 25 }, (_, index) =>
          task(first.id, { title: `Task ${index + 1}` }),
        ),
        task(second.id, { title: "   " }),
        task(second.id, { title: "x".repeat(2500) }),
        task(blank.id),
      ],
      settled: { "flag-1": { state: "kept" } },
    });
    const input = plannerCheckInput(plan, TODAY);
    expect(input.today).toBe(TODAY);
    expect(input.goals).toHaveLength(12);
    expect(input.goals[0]).toEqual({
      id: first.id,
      pillar: "work",
      title: "Goal 1",
      tasks: Array.from({ length: 20 }, (_, index) => `Task ${index + 1}`),
    });
    expect(input.goals[1]?.tasks).toEqual(["x".repeat(2000)]);
    expect(input.settled).toEqual([{ flag_id: "flag-1", state: "kept" }]);
    expect(plannerAiCheckSchema.safeParse(input).error).toBeUndefined();
  });

  it("changes the plan's signature when what the check reads changes, and only then", () => {
    const work = planGoal({ title: "Close two customers" });
    const blank = planGoal({ pillar: "ai", title: "" });
    const plan = forward({
      goals: [work, blank],
      tasks: [task(work.id, { title: "Call Ana" })],
    });
    const signature = plannerPlanSignature(plan);
    // Moving between steps, sending a card back or a goal with no title change nothing.
    expect(
      plannerPlanSignature({
        ...plan,
        step: 4,
        seen: false,
        toBacklog: ["tasks/x"],
      }),
    ).toBe(signature);
    expect(
      plannerPlanSignature({
        ...plan,
        goals: [
          { ...work, title: "  Close two customers " },
          { ...blank, pillar: "health" },
        ],
      }),
    ).toBe(signature);
    // A goal's words or objective, a task or a settled flag do.
    expect(
      plannerPlanSignature({
        ...plan,
        goals: [{ ...work, title: "Close three customers" }, blank],
      }),
    ).not.toBe(signature);
    expect(
      plannerPlanSignature({
        ...plan,
        goals: [{ ...work, pillar: "of" }, blank],
      }),
    ).not.toBe(signature);
    expect(
      plannerPlanSignature(plannerAddNewTask(plan, work.id, "Call Ben")),
    ).not.toBe(signature);
    expect(
      plannerPlanSignature({ ...plan, settled: { f1: { state: "kept" } } }),
    ).not.toBe(signature);
  });

  it("sends each settled flag as kept or rewritten, a rewrite with no words as kept", () => {
    expect(
      plannerSettledInput({
        settled: {
          a: { state: "kept" },
          b: { state: "rewritten", title: "  Close one customer  " },
          c: { state: "rewritten", title: " " },
          d: { state: "rewritten", title: "w".repeat(1200) },
        },
      }),
    ).toEqual([
      { flag_id: "a", state: "kept" },
      { flag_id: "b", state: "rewritten", title: "Close one customer" },
      { flag_id: "c", state: "kept" },
      { flag_id: "d", state: "rewritten", title: "w".repeat(1000) },
    ]);
    const many = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        `flag-${index}`,
        { state: "kept" as const },
      ]),
    );
    expect(plannerSettledInput({ settled: many })).toHaveLength(24);
  });

  it("keeps at most five of the check's flags, each within the save's limits", () => {
    const work = planGoal();
    const flag = (
      overrides: Partial<PlannerAiCheckResponse["flags"][number]> = {},
    ): PlannerAiCheckResponse["flags"][number] => ({
      goal_id: work.id,
      pillar: "work",
      with_goal_id: null,
      with_label: "Year goal: Revenue",
      why: "Both ask for the same evenings.",
      ...overrides,
    });
    const flags = plannerCheckFlags(
      [
        flag({ why: "  " }),
        flag({ with_label: "" }),
        flag({ goal_id: "not-in-the-plan", with_goal_id: "  goal-42  " }),
        flag({ with_label: "l".repeat(200), why: ` ${"w".repeat(400)}` }),
        flag(),
        flag(),
        flag(),
        flag(),
      ],
      forward({ goals: [work] }),
    );
    expect(flags).toHaveLength(5);
    expect(flags[0]).toEqual({
      goal_id: null,
      pillar: "work",
      with_goal_id: "goal-42",
      with_label: "Year goal: Revenue",
      why: "Both ask for the same evenings.",
    });
    expect(flags[1]).toEqual({
      goal_id: work.id,
      pillar: "work",
      with_goal_id: null,
      with_label: "l".repeat(120),
      why: "w".repeat(300),
    });
  });

  it("stays within the save's limits: 12 goals, 40 tasks, refs of 64 characters and 5 flags", () => {
    const goals = Array.from({ length: 13 }, (_, index) =>
      planGoal({ title: `Goal ${index + 1}` }),
    );
    const [first, second] = goals;
    const thirteenth = goals[12];
    if (!first || !second || !thirteenth) throw new Error("No goals.");
    let plan = forward({ goals });
    for (let index = 0; index < 30; index += 1) {
      plan = plannerAddBoardTask(plan, first.id, card(), "backlog");
    }
    const longId = card({ id: `tasks/${"9".repeat(90)}` });
    plan = plannerAddBoardTask(plan, first.id, longId, "doing");
    for (let index = 0; index < 15; index += 1) {
      plan = plannerAddNewTask(plan, second.id, `New task ${index + 1}`);
    }
    plan = plannerAddNewTask(plan, thirteenth.id, "A task of the 13th goal");
    const flags = plannerCheckFlags(
      Array.from({ length: 8 }, () => ({
        goal_id: first.id,
        pillar: "work" as const,
        with_goal_id: null,
        with_label: "Year goal: Revenue",
        why: "Both ask for the same evenings.",
      })),
      plan,
    );
    const input = plannerCommitInput(plan, "Did I close them?", flags, TODAY);
    expect(input.goals).toHaveLength(12);
    expect(input.goals.map((item) => item.id)).not.toContain(thirteenth.id);
    expect(input.tasks).toHaveLength(40);
    expect(input.tasks.every((item) => item.goal_id !== thirteenth.id)).toBe(
      true,
    );
    expect(input.tasks.every((item) => item.ref.length <= 64)).toBe(true);
    expect(input.tasks).toContainEqual({
      ref: `t-tasks/${"9".repeat(56)}`,
      goal_id: first.id,
      task_id: longId.id,
    });
    expect(input.flags).toHaveLength(5);
    expect(plannerCommitSchema.safeParse(input).error).toBeUndefined();
  });

  it("sends a card by its id and a new task by its title, for the named goals only", () => {
    const work = planGoal({ title: "  Close two customers  " });
    const blank = planGoal({ pillar: "ai", title: " " });
    const picked = card();
    let plan = forward({ goals: [work, blank] });
    plan = plannerAddBoardTask(plan, work.id, picked, "todo");
    plan = plannerAddNewTask(plan, work.id, "Call Ana");
    plan = plannerAddNewTask(plan, blank.id, "Left with its goal");
    const input = plannerCommitInput(plan, "  Did I close them?  ", [], TODAY);
    expect(input).toEqual({
      today: TODAY,
      goals: [{ id: work.id, pillar: "work", title: "Close two customers" }],
      tasks: [
        { ref: `t-${picked.id}`, goal_id: work.id, task_id: picked.id },
        {
          ref: expect.stringMatching(UUID),
          goal_id: work.id,
          title: "Call Ana",
        },
      ],
      to_backlog: [],
      question: "Did I close them?",
      settled: [],
      flags: [],
    });
    expect(plannerCommitSchema.safeParse(input).error).toBeUndefined();
  });

  it("never sends a planned card back to Backlog, and sends a blank question as none", () => {
    const work = planGoal();
    const planned = card();
    const other = card();
    const plan = forward({
      goals: [work],
      toBacklog: [planned.id, other.id],
      tasks: [
        {
          ref: `t-${planned.id}`,
          goal_id: work.id,
          task_id: planned.id,
          title: planned.title,
          source: "todo",
        },
      ],
    });
    const input = plannerCommitInput(plan, "   ", [], TODAY);
    expect(input.to_backlog).toEqual([other.id]);
    expect(input.question).toBeNull();
    expect(
      plannerCommitInput(plan, "q".repeat(600), [], TODAY).question,
    ).toHaveLength(500);
  });
});

// ---------------------------------------------------------------------------

describe("saved state", () => {
  // The plan was saved before: its goals carry the server's ids, so a fresh
  // state is the same every time.
  const planned = goal({
    period_start: PLAN_WEEK,
    title: "Close two customers",
  });
  const lastWeeks = goal({ result: "met" });
  const r = review({
    last_question: "Did I rest?",
    week_goals: [lastWeeks],
    plan_goals: [planned],
  });

  /** A state as the page saves it: JSON, read back as plain data. */
  const savedAs = (state: unknown) =>
    JSON.parse(JSON.stringify(state)) as {
      v: number;
      back: Record<string, unknown>;
      forward: Record<string, unknown>;
    };

  it("starts with Look back at its start and Look forward unseen", () => {
    expect(plannerNewReviewState(r)).toEqual({
      v: 1,
      back: plannerNewBackState(r),
      forward: plannerNewForwardState(r),
    });
  });

  it("picks a saved review up where it was left", () => {
    let back = plannerAddAnswer(opened(r), r, "Partly").back;
    back = plannerAddProbe(
      plannerAddCoachReply(back, "What got in the way?", false),
    );
    let plan: PlannerForwardState = {
      ...plannerNewForwardState(r),
      seen: true,
      step: 3,
    };
    plan = plannerAddNewTask(plan, planned.id, "Call Ana");
    plan = plannerAddBoardTask(plan, planned.id, card(), "backlog");
    plan = {
      ...plan,
      goals: [
        ...plan.goals,
        planGoal({ pillar: "health", title: "Run", fromSummary: LAST_WEEK }),
        planGoal({ pillar: "ai", title: "", custom: true }),
      ],
      toBacklog: ["tasks/old"],
      settled: { "flag-1": { state: "rewritten", title: "Close one" } },
    };
    const state: PlannerReviewState = { v: 1, back, forward: plan };
    expect(plannerRestoreReviewState(savedAs(state), r)).toEqual(state);
  });

  it("starts over from a saved state that does not fit", () => {
    const fresh = plannerNewReviewState(r);
    const good = savedAs(fresh);
    const answers = plannerReviewPrompts.map((): unknown[] => []);
    const withBack = (change: Record<string, unknown>) => ({
      ...good,
      back: { ...good.back, ...change },
    });
    const withForward = (change: Record<string, unknown>) => ({
      ...good,
      forward: { ...good.forward, ...change },
    });
    const cases: Array<[string, unknown]> = [
      ["nothing saved", null],
      ["text", "lookback"],
      ["a list", [good]],
      ["another version", { ...good, v: 2 }],
      ["no Look back", { ...good, back: undefined }],
      ["no Look forward", { ...good, forward: [] }],
      ["an unknown stage", withBack({ stage: "lunch" })],
      ["a chat that is not a list", withBack({ log: {} })],
      ["a coach history that is not a list", withBack({ conv: null })],
      ["answers for six prompts", withBack({ answers: answers.slice(1) })],
      [
        "an answer that is not text",
        withBack({ answers: [[4], ...answers.slice(1)] }),
      ],
      ["last week's answers not a list", withBack({ lastAnswer: "Partly" })],
      ["goals that are not a list", withForward({ goals: {} })],
      ["tasks that are not a list", withForward({ tasks: "none" })],
    ];
    for (const [name, saved] of cases) {
      expect(plannerRestoreReviewState(saved, r), name).toEqual(fresh);
    }
  });

  it("keeps a stage that was waiting on the model, so the page runs the call again", () => {
    for (const stage of ["drafting", "scoring"] as const) {
      const saved = savedAs({
        ...plannerNewReviewState(r),
        back: { ...plannerNewBackState(r), stage },
      });
      expect(plannerRestoreReviewState(saved, r).back.stage).toBe(stage);
    }
  });

  it("fills in what an older save lacks, and takes the server's results for goals it does not know", () => {
    const added = goal({ result: "missed" });
    const later = { ...r, week_goals: [lastWeeks, added] };
    const saved = savedAs(plannerNewReviewState(r));
    Reflect.deleteProperty(saved.back, "memoStopped");
    Reflect.deleteProperty(saved.back, "probes");
    Reflect.deleteProperty(saved.forward, "prefilled");
    saved.back.goalResults = { [lastWeeks.id]: "partial" };
    const restored = plannerRestoreReviewState(saved, later);
    expect(restored.back.memoStopped).toBe(false);
    expect(restored.back.probes).toEqual([0, 0, 0, 0, 0, 0, 0]);
    expect(restored.forward.prefilled).toBe(false);
    // The owner's own result wins; a goal the save never saw has the server's.
    expect(restored.back.goalResults).toEqual({
      [lastWeeks.id]: "partial",
      [added.id]: "missed",
    });
  });

  it("repairs a bad Look forward step, settled list, To Do list or probe count instead of starting over", () => {
    const good = savedAs(plannerNewReviewState(r));
    const restore = (change: Record<string, unknown>) =>
      plannerRestoreReviewState(
        { ...good, forward: { ...good.forward, ...change } },
        r,
      ).forward;
    expect(restore({ step: 3 }).step).toBe(3);
    expect(restore({ step: 2.7 }).step).toBe(2);
    expect(restore({ step: 9 }).step).toBe(1);
    expect(restore({ step: 0 }).step).toBe(1);
    expect(restore({ step: "3" }).step).toBe(1);
    expect(restore({ settled: [] }).settled).toEqual({});
    expect(restore({ settled: { f1: { state: "kept" } } }).settled).toEqual({
      f1: { state: "kept" },
    });
    expect(restore({ toBacklog: [1, 2] }).toBacklog).toEqual([]);
    expect(restore({ toBacklog: ["tasks/a"] }).toBacklog).toEqual(["tasks/a"]);
    const back = plannerRestoreReviewState(
      { ...good, back: { ...good.back, probes: [1, 1] } },
      r,
    ).back;
    expect(back.probes).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("drops the plan's goals and tasks it cannot draw, and the tasks of a goal that is gone", () => {
    const kept = planGoal({ title: "Kept", fromSummary: LAST_WEEK });
    const keptTask = task(kept.id, { task_id: "tasks/a", source: "todo" });
    const good = savedAs(plannerNewReviewState(r));
    const restored = plannerRestoreReviewState(
      {
        ...good,
        forward: {
          ...good.forward,
          goals: [
            kept,
            { ...planGoal(), pillar: "sleep" },
            { id: 7, pillar: null, title: "Odd id" },
            { id: uuid(), pillar: "ai" },
            "a goal",
            // An older save marked a goal from a summary with `true`.
            { ...planGoal({ title: "Older" }), fromSummary: true },
            { ...planGoal({ title: "Custom" }), custom: "yes" },
          ],
          tasks: [
            keptTask,
            task(uuid()),
            { ...task(kept.id), source: "someday" },
            { ...task(kept.id), task_id: 42 },
            { ...task(kept.id), title: null },
            null,
          ],
        },
      },
      r,
    ).forward;
    expect(restored.goals.map((item) => item.title)).toEqual([
      "Kept",
      "Older",
      "Custom",
    ]);
    expect(restored.goals[0]).toEqual(kept);
    expect(restored.goals[1]).not.toHaveProperty("fromSummary");
    expect(restored.goals[2]).not.toHaveProperty("custom");
    expect(restored.tasks).toEqual([keptTask]);
  });
});
