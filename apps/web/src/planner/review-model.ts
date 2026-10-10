import {
  type PlannerAiCheckInput,
  type PlannerAiCheckResponse,
  type PlannerAiCloseInput,
  type PlannerAiCloseResponse,
  type PlannerAiOpeningResponse,
  type PlannerBoardCard,
  type PlannerBoardResponse,
  type PlannerCommitInput,
  type PlannerGoalResult,
  type PlannerLookBackInput,
  type PlannerPillar,
  type PlannerReviewChatMessage,
  type PlannerReviewResponse,
  type PlannerSummaryMemoInput,
  type PlannerVerdictKind,
  plannerAddDays,
  plannerGoalResults,
  plannerMemoNextSteps,
  plannerPillarNames,
  plannerPillars,
  plannerReviewPrompts,
  plannerScoreFloors,
  plannerSnapScore,
  plannerVerdictKinds,
} from "@flaremo/contracts";
import { plannerGoalText } from "./goals-model";

// The weekly review's own state (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): what the page records as the owner
// goes through Look back and Look forward, kept as plain data so it can be
// saved to the server as it changes and picked up again on another visit. The
// functions here are pure; the page (review-page.tsx) runs the model calls and
// the saves around them.
//
// Look back is a chat in stages:
//
//   start → drafting → lastq → goals → p (seven prompts) → scoring → scores
//         → question → verdict → done
//
// `lastq` (last week's question) and `goals` (last week's goals) are skipped
// when there is nothing to ask. The model drafts answer options when Look back
// starts and drafts the scores and trajectory after the seven prompts; without
// a model the page uses its own drafts, so the review always runs to the end.

export const plannerReviewStages = [
  "start",
  "drafting",
  "lastq",
  "goals",
  "p",
  "scoring",
  "scores",
  "question",
  "verdict",
  "done",
] as const;
export type PlannerReviewStage = (typeof plannerReviewStages)[number];

/** One entry of the Look back chat. Prompts and cards are drawn from the state. */
export type PlannerReviewEntry =
  | { k: "sys"; text: string }
  | { k: "user"; text: string }
  | { k: "coach"; text: string }
  | { k: "recap" }
  | { k: "lastq" }
  | { k: "goals" }
  | { k: "prompt"; i: number }
  | { k: "scores" }
  | { k: "question" }
  | { k: "verdict" }
  | { k: "done" };

export type PlannerReviewDrafts = {
  recap: string;
  lastq: string[];
  /** Answer options for each of the seven prompts; empty where there are none. */
  prompts: string[][];
  scores: {
    auth: number;
    ach: number;
    auth_evidence: string;
    ach_evidence: string;
  };
  trajectory: {
    pattern: string;
    risk: string;
    opportunity: string;
    questions: string[];
    verdicts: Record<PlannerVerdictKind, string>;
    recommended: PlannerVerdictKind | null;
  };
};

export type PlannerBackState = {
  stage: PlannerReviewStage;
  /** The prompt being asked, 0 to 6. */
  pi: number;
  lastAnswer: string[];
  lastProbes: number;
  /** Last week's goals, by id: the result the owner gave each. */
  goalResults: Record<string, PlannerGoalResult | null>;
  answers: string[][];
  probes: number[];
  log: PlannerReviewEntry[];
  /** The chat as the coach reads it. */
  conv: PlannerReviewChatMessage[];
  drafts: PlannerReviewDrafts | null;
  scores: { auth: number; ach: number } | null;
  question: string | null;
  verdict: { kind: PlannerVerdictKind; text: string } | null;
  memo: string | null;
  /** Who wrote the memo: the model, or the page's template. */
  memoBy: "model" | "page" | null;
  /** The model's memo was stopped before it finished. */
  memoStopped: boolean;
  /** The memo, scores and results were saved (Look back is done). */
  memoSaved: boolean;
};

/** A goal of the plan. Its id is the page's UUID, which the server keeps. */
export type PlannerPlanGoal = {
  id: string;
  pillar: PlannerPillar | null;
  title: string;
  /**
   * The Monday of the week whose summary memo's Next Steps filled it in;
   * absent once the owner writes it.
   */
  fromSummary?: string;
  /** Added by the owner: its objective can be changed. */
  custom?: boolean;
};

export type PlannerPlanTaskSource =
  | "new"
  | "todo"
  | "backlog"
  | "doing"
  | "done";

/** A task of the plan: a card from the board (`task_id`) or a new one. */
export type PlannerPlanTask = {
  /** The page's name for it, which makes a new task be created only once. */
  ref: string;
  goal_id: string;
  task_id?: string;
  title: string;
  source: PlannerPlanTaskSource;
};

export type PlannerSettled = { state: "kept" | "rewritten"; title?: string };

export type PlannerForwardState = {
  /** Look forward was opened. */
  seen: boolean;
  step: number;
  settled: Record<string, PlannerSettled>;
  goals: PlannerPlanGoal[];
  tasks: PlannerPlanTask[];
  /** To Do cards that go back to Backlog. */
  toBacklog: string[];
  question: string | null;
  /** The owner changed the goals or tasks: the summary no longer fills them. */
  edited: boolean;
  /** The board's cards that already serve the plan's goals were added. */
  prefilled: boolean;
};

export type PlannerReviewState = {
  v: 1;
  back: PlannerBackState;
  forward: PlannerForwardState;
};

type Review = Pick<
  PlannerReviewResponse,
  | "review_week"
  | "last_question"
  | "week_goals"
  | "plan_goals"
  | "scores"
  | "suggested_goals"
  | "summary"
  | "week"
>;

const PROMPT_COUNT = plannerReviewPrompts.length;

// The limits of the AI and save requests (packages/contracts/src/planner-goals.ts).
const MAX_ANSWER = 4000;
const MAX_ANSWERS = 12;
const MAX_COACH_NOTES = 20;
const MAX_COACH_NOTE = 2000;
const MAX_DRAFT = 1000;
const MAX_QUESTION = 500;
const MAX_VERDICT = 1000;
const MAX_CHAT = 40;
const MAX_CHAT_MESSAGE = 8000;

const clip = (value: string, max: number) => value.trim().slice(0, max).trim();

/** The page's id for a goal or a task ref. */
export function plannerNewId(): string {
  return crypto.randomUUID();
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

/** The latest scores before the review week, or the floors: where the steppers start. */
function startingScores(
  review: Pick<Review, "scores" | "review_week" | "week">,
) {
  if (review.week?.auth != null && review.week.ach != null) {
    return { auth: review.week.auth, ach: review.week.ach };
  }
  const scored = review.scores.filter(
    (week) =>
      week.week_start < review.review_week &&
      week.auth !== null &&
      week.ach !== null,
  );
  const last = scored.at(-1);
  return last && last.auth !== null && last.ach !== null
    ? { auth: last.auth, ach: last.ach }
    : { auth: plannerScoreFloors.auth, ach: plannerScoreFloors.ach };
}

/** A plain recap from the week's goals, for when no model wrote one. */
export function plannerFallbackRecap(
  review: Pick<Review, "week_goals">,
): string {
  const goals = review.week_goals;
  if (goals.length === 0) return "No weekly goals were set.";
  return `${goals.length} weekly goal${goals.length === 1 ? "" : "s"}: ${goals
    .map(
      (goal) =>
        `${goal.pillar ? `${plannerPillarNames[goal.pillar]}: ` : ""}${plannerGoalText(goal)}`,
    )
    .join("; ")}.`;
}

/** The page's own drafts: what the review runs on when no model answers. */
export function plannerFallbackDrafts(review: Review): PlannerReviewDrafts {
  const scores = startingScores(review);
  return {
    recap: plannerFallbackRecap(review),
    lastq: ["Yes", "Partly", "No"],
    prompts: plannerReviewPrompts.map(() => []),
    scores: { ...scores, auth_evidence: "", ach_evidence: "" },
    trajectory: {
      pattern: "",
      risk: "",
      opportunity: "",
      // Last week's question can carry over; the owner can always write another.
      questions: review.last_question ? [review.last_question] : [],
      verdicts: { continue: "Continue.", pivot: "Pivot.", pause: "Pause." },
      recommended: null,
    },
  };
}

const usable = (options: readonly string[], min = 2) => {
  const kept = options
    .map((option) => option.trim())
    .filter(Boolean)
    .slice(0, 3);
  return kept.length >= min ? kept : null;
};

/** The model's opening over the page's drafts: whatever it answered well wins. */
export function plannerMergeOpening(
  base: PlannerReviewDrafts,
  ai: PlannerAiOpeningResponse | null,
): PlannerReviewDrafts {
  if (!ai) return base;
  return {
    ...base,
    recap: ai.recap.trim() || base.recap,
    lastq: usable(ai.lastq) ?? base.lastq,
    prompts: base.prompts.map(
      (options, index) => usable(ai.prompts[index] ?? []) ?? options,
    ),
  };
}

/** The model's scores and trajectory over the drafts so far. */
export function plannerMergeClose(
  base: PlannerReviewDrafts,
  ai: PlannerAiCloseResponse | null,
): PlannerReviewDrafts {
  if (!ai) return base;
  const verdicts = { ...base.trajectory.verdicts };
  for (const kind of plannerVerdictKinds) {
    const text = ai.trajectory.verdicts[kind]?.trim();
    if (text) verdicts[kind] = text;
  }
  return {
    ...base,
    scores: {
      auth: plannerSnapScore(ai.scores.auth) ?? base.scores.auth,
      ach: plannerSnapScore(ai.scores.ach) ?? base.scores.ach,
      auth_evidence:
        ai.scores.auth_evidence.trim() || base.scores.auth_evidence,
      ach_evidence: ai.scores.ach_evidence.trim() || base.scores.ach_evidence,
    },
    trajectory: {
      pattern: ai.trajectory.pattern.trim() || base.trajectory.pattern,
      risk: ai.trajectory.risk.trim() || base.trajectory.risk,
      opportunity:
        ai.trajectory.opportunity.trim() || base.trajectory.opportunity,
      questions:
        usable(ai.trajectory.questions, 1) ?? base.trajectory.questions,
      verdicts,
      recommended: ai.trajectory.recommended ?? base.trajectory.recommended,
    },
  };
}

// ---------------------------------------------------------------------------
// Look back
// ---------------------------------------------------------------------------

export function plannerNewBackState(review: Review): PlannerBackState {
  return {
    stage: "start",
    pi: 0,
    lastAnswer: [],
    lastProbes: 0,
    goalResults: Object.fromEntries(
      review.week_goals.map((goal) => [goal.id, goal.result]),
    ),
    answers: plannerReviewPrompts.map(() => []),
    probes: plannerReviewPrompts.map(() => 0),
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
  };
}

/** Whether Look back has moved past `stage`. */
export function plannerPastStage(
  back: Pick<PlannerBackState, "stage">,
  stage: PlannerReviewStage,
): boolean {
  return (
    plannerReviewStages.indexOf(back.stage) > plannerReviewStages.indexOf(stage)
  );
}

/** The drafts in use: the model's or the page's. */
export function plannerDraftsOf(
  back: Pick<PlannerBackState, "drafts">,
  review: Review,
): PlannerReviewDrafts {
  return back.drafts ?? plannerFallbackDrafts(review);
}

const push = (
  back: PlannerBackState,
  ...entries: PlannerReviewEntry[]
): PlannerBackState => ({ ...back, log: [...back.log, ...entries] });

/** Adds a note from the page once (a model that is down is said only once). */
export function plannerSysOnce(
  back: PlannerBackState,
  text: string,
): PlannerBackState {
  return back.log.some((entry) => entry.k === "sys" && entry.text === text)
    ? back
    : push(back, { k: "sys", text });
}

/**
 * Look back starts asking: the recap, then last week's question, last week's
 * goals or the first prompt, whichever comes first.
 */
export function plannerOpenQuestions(
  back: PlannerBackState,
  review: Review,
  drafts: PlannerReviewDrafts,
): PlannerBackState {
  const next: PlannerBackState = push(
    {
      ...back,
      drafts,
      scores: back.scores ?? {
        auth: drafts.scores.auth,
        ach: drafts.scores.ach,
      },
    },
    { k: "recap" },
  );
  if (review.last_question) {
    return push({ ...next, stage: "lastq" }, { k: "lastq" });
  }
  if (review.week_goals.length > 0) {
    return push({ ...next, stage: "goals" }, { k: "goals" });
  }
  return push({ ...next, stage: "p", pi: 0 }, { k: "prompt", i: 0 });
}

/**
 * The next step of Look back. After the seventh prompt it is `scoring`, which
 * the page leaves once the scores are drafted (plannerOpenScores).
 */
export function plannerAdvance(
  back: PlannerBackState,
  review: Review,
): PlannerBackState {
  if (back.stage === "lastq") {
    if (review.week_goals.length > 0) {
      return push({ ...back, stage: "goals" }, { k: "goals" });
    }
    return push({ ...back, stage: "p", pi: 0 }, { k: "prompt", i: 0 });
  }
  if (back.stage === "goals") {
    return push({ ...back, stage: "p", pi: 0 }, { k: "prompt", i: 0 });
  }
  if (back.stage === "p") {
    if (back.pi < PROMPT_COUNT - 1) {
      return push(
        { ...back, pi: back.pi + 1 },
        { k: "prompt", i: back.pi + 1 },
      );
    }
    return { ...back, stage: "scoring" };
  }
  if (back.stage === "scores") {
    return push({ ...back, stage: "question" }, { k: "question" });
  }
  if (back.stage === "question") {
    return push({ ...back, stage: "verdict" }, { k: "verdict" });
  }
  if (back.stage === "verdict") {
    return push({ ...back, stage: "done" }, { k: "done" });
  }
  return back;
}

/** The scores are drafted: the score card opens with them. */
export function plannerOpenScores(
  back: PlannerBackState,
  drafts: PlannerReviewDrafts,
): PlannerBackState {
  return push(
    {
      ...back,
      drafts,
      stage: "scores",
      scores: { auth: drafts.scores.auth, ach: drafts.scores.ach },
    },
    { k: "scores" },
  );
}

/** A score moved by the stepper, kept on the 1 to 5 scale. */
export function plannerStepScore(value: number, delta: number): number {
  return Math.min(5, Math.max(1, Math.round((value + delta) * 2) / 2));
}

/**
 * A verdict's kind, from the word it starts with: "Pivot toward…" is a pivot,
 * "Pivotal week…" is not. Chinese has no spaces, so its two words are prefixes.
 */
export function plannerVerdictKindOf(text: string): PlannerVerdictKind {
  const trimmed = text.trim();
  const word = /^\p{L}+/u.exec(trimmed)?.[0].toLowerCase() ?? "";
  if (/^pivot(s|ed|ing)?$/.test(word) || trimmed.startsWith("转向")) {
    return "pivot";
  }
  if (/^paus(e|es|ed|ing)$/.test(word) || trimmed.startsWith("暂停")) {
    return "pause";
  }
  return "continue";
}

/**
 * The owner answered, by tapping an option or writing. Returns the state with
 * the answer recorded in the chat, the answers and the coach's history, and
 * whether the coach should reply now (`coach`), or the review moves on.
 */
export function plannerAddAnswer(
  back: PlannerBackState,
  review: Review,
  raw: string,
): { back: PlannerBackState; reply: "coach" | "advance" | "chat" | "none" } {
  const text = clip(raw, MAX_ANSWER);
  if (!text) return { back, reply: "none" };
  const said = push(back, { k: "user", text });
  const withConv = (state: PlannerBackState, content: string) => ({
    ...state,
    conv: [...state.conv, { role: "user" as const, content }],
  });

  if (back.stage === "lastq" || back.stage === "p") {
    const list =
      back.stage === "lastq" ? back.lastAnswer : (back.answers[back.pi] ?? []);
    if (list.length >= MAX_ANSWERS) return { back, reply: "none" };
    const head =
      list.length > 0
        ? ""
        : back.stage === "lastq"
          ? `[Last week's key question: "${review.last_question ?? ""}"]\n`
          : `[Prompt ${back.pi + 1} of ${PROMPT_COUNT}: ${plannerReviewPrompts[back.pi]?.question ?? ""}]\n`;
    const recorded: PlannerBackState =
      back.stage === "lastq"
        ? { ...said, lastAnswer: [...list, text] }
        : {
            ...said,
            answers: said.answers.map((answers, index) =>
              index === back.pi ? [...answers, text] : answers,
            ),
          };
    return { back: withConv(recorded, head + text), reply: "coach" };
  }
  if (back.stage === "question") {
    const question = clip(text, MAX_QUESTION);
    return {
      back: withConv(
        { ...said, question },
        `[Question for next Sunday] ${question}`,
      ),
      reply: "advance",
    };
  }
  if (back.stage === "verdict") {
    const verdict = {
      kind: plannerVerdictKindOf(text),
      text: clip(text, MAX_VERDICT),
    };
    return {
      back: withConv({ ...said, verdict }, `[Verdict] ${verdict.text}`),
      reply: "advance",
    };
  }
  if (back.stage === "scores" || back.stage === "done") {
    const tag =
      back.stage === "scores" && back.scores
        ? `[Scores step, draft Authenticity ${back.scores.auth.toFixed(1)}, Achievement ${back.scores.ach.toFixed(1)}]`
        : "[After the prompts]";
    return { back: withConv(said, `${tag} ${text}`), reply: "chat" };
  }
  return { back, reply: "none" };
}

/**
 * How the coach should answer now: it may probe once (twice for the blindspot,
 * prompt 6), after which it only acknowledges and the review moves on.
 */
export function plannerCoachMode(
  back: PlannerBackState,
): "free" | "force" | "chat" {
  if (back.stage === "lastq") return back.lastProbes >= 1 ? "force" : "free";
  if (back.stage === "p") {
    const max = back.pi === 5 ? 2 : 1;
    return (back.probes[back.pi] ?? 0) >= max ? "force" : "free";
  }
  return "chat";
}

/** The coach replied: its words join the chat and the history it reads. */
export function plannerAddCoachReply(
  back: PlannerBackState,
  text: string,
  advance: boolean,
): PlannerBackState {
  const reply = text.trim();
  if (!reply) return back;
  return {
    ...push(back, { k: "coach", text: reply }),
    // The history keeps the control line the coach ends with, so its later
    // replies keep writing it (the server strips it from what the page sees).
    conv: [
      ...back.conv,
      {
        role: "assistant",
        content: clip(`${reply}\n@@ {"advance": ${advance}}`, MAX_CHAT_MESSAGE),
      },
    ],
  };
}

/** The coach asked a question: the next answer counts against the probes. */
export function plannerAddProbe(back: PlannerBackState): PlannerBackState {
  if (back.stage === "lastq")
    return { ...back, lastProbes: back.lastProbes + 1 };
  if (back.stage === "p") {
    return {
      ...back,
      probes: back.probes.map((count, index) =>
        index === back.pi ? count + 1 : count,
      ),
    };
  }
  return back;
}

/** The chat the coach reads: the last turns, starting with the owner's. */
export function plannerCoachMessages(
  back: Pick<PlannerBackState, "conv">,
): PlannerReviewChatMessage[] {
  let history = back.conv.slice(-MAX_CHAT);
  while (history.length && history[0]?.role !== "user")
    history = history.slice(1);
  return history.map((message) => ({
    role: message.role,
    content: clip(message.content, MAX_CHAT_MESSAGE) || "…",
  }));
}

/** The coach's own words in the chat, newest last, for the close and the memo. */
function coachNotes(back: PlannerBackState): string[] {
  return back.log
    .filter(
      (entry): entry is { k: "coach"; text: string } => entry.k === "coach",
    )
    .map((entry) => clip(entry.text, MAX_COACH_NOTE))
    .filter(Boolean)
    .slice(-MAX_COACH_NOTES);
}

/** The week's goal results, as the saves and the model read them. */
export function plannerGoalResultsInput(
  back: Pick<PlannerBackState, "goalResults">,
  review: Pick<Review, "week_goals">,
) {
  return review.week_goals.slice(0, 24).map((goal) => {
    const result = back.goalResults[goal.id];
    return {
      goal_id: goal.id,
      result:
        result && (plannerGoalResults as readonly string[]).includes(result)
          ? result
          : null,
    };
  });
}

/** What the owner has answered so far, as the close, the memo and the save read it. */
export function plannerAnswersInput(
  back: PlannerBackState,
  review: Review,
): Omit<PlannerAiCloseInput, "today"> {
  const list = (answers: readonly string[]) =>
    answers
      .map((answer) => clip(answer, MAX_ANSWER))
      .filter(Boolean)
      .slice(0, MAX_ANSWERS);
  return {
    last_answer: list(back.lastAnswer),
    answers: plannerReviewPrompts.map((_, index) =>
      list(back.answers[index] ?? []),
    ),
    goal_results: plannerGoalResultsInput(back, review),
    coach_notes: coachNotes(back),
  };
}

/** The memo request's drafts, within its limits. */
export function plannerMemoDrafts(drafts: PlannerReviewDrafts) {
  return {
    auth_evidence: clip(drafts.scores.auth_evidence, MAX_DRAFT),
    ach_evidence: clip(drafts.scores.ach_evidence, MAX_DRAFT),
    pattern: clip(drafts.trajectory.pattern, MAX_DRAFT),
    risk: clip(drafts.trajectory.risk, MAX_DRAFT),
    opportunity: clip(drafts.trajectory.opportunity, MAX_DRAFT),
  };
}

/** Everything the page's memo template needs. */
export function plannerSummaryInput(
  back: PlannerBackState,
  review: Review,
  today: string,
): PlannerSummaryMemoInput {
  const drafts = plannerDraftsOf(back, review);
  const scores = back.scores ?? {
    auth: drafts.scores.auth,
    ach: drafts.scores.ach,
  };
  return {
    weekStart: review.review_week,
    reviewedOn: today,
    recap: drafts.recap,
    lastQuestion: review.last_question,
    lastAnswer: back.lastAnswer,
    goals: review.week_goals.map((goal) => ({
      pillar: goal.pillar,
      title: plannerGoalText(goal),
      result: back.goalResults[goal.id] ?? null,
    })),
    answers: back.answers,
    scores,
    authBasis: drafts.scores.auth_evidence,
    achBasis: drafts.scores.ach_evidence,
    trajectory: drafts.trajectory,
    question: back.question,
    verdict: back.verdict,
    recommended: drafts.trajectory.recommended,
  };
}

/** The Look back save. */
export function plannerLookBackInput(
  back: PlannerBackState,
  review: Review,
  today: string,
  memo: string,
): PlannerLookBackInput | null {
  const drafts = plannerDraftsOf(back, review);
  const scores = back.scores ?? {
    auth: drafts.scores.auth,
    ach: drafts.scores.ach,
  };
  const auth = plannerSnapScore(scores.auth);
  const ach = plannerSnapScore(scores.ach);
  if (auth === null || ach === null || !memo.trim()) return null;
  return {
    today,
    scores: { auth, ach },
    question: back.question ? clip(back.question, MAX_QUESTION) || null : null,
    verdict: back.verdict?.text.trim()
      ? { kind: back.verdict.kind, text: clip(back.verdict.text, MAX_VERDICT) }
      : null,
    goal_results: plannerGoalResultsInput(back, review),
    memo: memo.trim().slice(0, 100_000),
  };
}

// ---------------------------------------------------------------------------
// Look forward
// ---------------------------------------------------------------------------

/**
 * The plan's goals to start from: the ones already saved for the week, else the
 * Next Steps of the latest summary, else one empty goal per objective.
 */
export function plannerInitialPlanGoals(
  review: Pick<
    Review,
    "plan_goals" | "suggested_goals" | "summary" | "review_week"
  >,
): PlannerPlanGoal[] {
  if (review.plan_goals.length > 0) {
    return review.plan_goals.map((goal) => ({
      id: goal.id,
      pillar: goal.pillar,
      title: plannerGoalText(goal),
    }));
  }
  // The server reads the Next Steps from this week's summary once it exists,
  // else from last week's.
  const from = review.summary
    ? review.review_week
    : plannerAddDays(review.review_week, -7);
  return plannerPillars.map((pillar) => {
    const step = review.suggested_goals[pillar]?.trim();
    return {
      id: plannerNewId(),
      pillar,
      title: step ?? "",
      ...(step ? { fromSummary: from } : {}),
    };
  });
}

export function plannerNewForwardState(
  review: Pick<
    Review,
    "plan_goals" | "suggested_goals" | "summary" | "review_week"
  >,
): PlannerForwardState {
  return {
    seen: false,
    step: 1,
    settled: {},
    goals: plannerInitialPlanGoals(review),
    tasks: [],
    toBacklog: [],
    question: null,
    edited: false,
    prefilled: false,
  };
}

/**
 * The summary memo was written: its Next Steps fill the plan's goals, unless
 * the owner already changed the plan or it was saved before. A goal that
 * changes loses the tasks drafted for it.
 */
export function plannerPlanFromMemo(
  forward: PlannerForwardState,
  memo: string,
  locked: boolean,
  /** The Monday of the week the memo sums up. */
  week: string,
): PlannerForwardState {
  if (forward.edited || locked) return forward;
  const steps = plannerMemoNextSteps(memo);
  let goals = forward.goals;
  let tasks = forward.tasks;
  for (const pillar of plannerPillars) {
    const step = steps[pillar];
    if (!step) continue;
    const goal = goals.find((item) => item.pillar === pillar);
    if (goal && goal.title === step) continue;
    if (goal) {
      goals = goals.map((item) =>
        item.id === goal.id
          ? { ...item, title: step, fromSummary: week }
          : item,
      );
      tasks = tasks.filter((task) => task.goal_id !== goal.id);
    } else {
      goals = [
        ...goals,
        { id: plannerNewId(), pillar, title: step, fromSummary: week },
      ];
    }
  }
  return goals === forward.goals ? forward : { ...forward, goals, tasks };
}

/** The plan's goals that have a title: the ones that will be saved. */
export function plannerNamedGoals(forward: Pick<PlannerForwardState, "goals">) {
  return forward.goals.filter((goal) => goal.title.trim());
}

const COLUMNS = ["todo", "backlog", "doing", "done"] as const;

/** The board's live cards with their column. */
function boardCards(board: Pick<PlannerBoardResponse, "columns">) {
  return COLUMNS.flatMap((column) =>
    board.columns[column].map((card) => ({ card, column })),
  );
}

/**
 * Adds the board's cards that already serve one of the plan's goals (a plan
 * saved earlier, or tasks linked on the cockpit), so saving again keeps them.
 */
export function plannerPrefillTasks(
  forward: PlannerForwardState,
  board: Pick<PlannerBoardResponse, "columns">,
): PlannerForwardState {
  if (forward.prefilled) return forward;
  const goalIds = new Set(forward.goals.map((goal) => goal.id));
  const named = new Set(
    forward.tasks.flatMap((task) => (task.task_id ? [task.task_id] : [])),
  );
  const added: PlannerPlanTask[] = boardCards(board)
    .filter(
      ({ card }) =>
        card.goal_id !== null &&
        goalIds.has(card.goal_id) &&
        !named.has(card.id),
    )
    .map(({ card, column }) => ({
      ref: `t-${card.id}`.slice(0, 64),
      goal_id: card.goal_id ?? "",
      task_id: card.id,
      title: card.title,
      source: column,
    }));
  return { ...forward, tasks: [...forward.tasks, ...added], prefilled: true };
}

/** The cards the plan already names. */
function namedCardIds(
  forward: Pick<PlannerForwardState, "tasks">,
): Set<string> {
  return new Set(
    forward.tasks.flatMap((task) => (task.task_id ? [task.task_id] : [])),
  );
}

/** To Do cards that are not part of the plan: they stay, or go back to Backlog. */
export function plannerOtherTodo(
  forward: Pick<PlannerForwardState, "tasks">,
  board: Pick<PlannerBoardResponse, "columns">,
): PlannerBoardCard[] {
  const named = namedCardIds(forward);
  return board.columns.todo.filter((card) => !named.has(card.id));
}

/**
 * How many cards To Do will hold once the plan is saved: the To Do cards that
 * stay, and the plan's tasks that join, read from where each card is now (a
 * plan saved before has already moved its cards).
 */
export function plannerTodoCount(
  forward: Pick<PlannerForwardState, "tasks" | "toBacklog" | "goals">,
  board: Pick<PlannerBoardResponse, "columns">,
): number {
  const moved = new Set(forward.toBacklog);
  const named = new Set(plannerNamedGoals(forward).map((goal) => goal.id));
  const inBacklog = new Set(board.columns.backlog.map((card) => card.id));
  const planned = forward.tasks.filter((task) => named.has(task.goal_id));
  const staying = board.columns.todo.filter(
    (card) => !moved.has(card.id),
  ).length;
  const joining = planned.filter((task) =>
    task.task_id ? inBacklog.has(task.task_id) : task.source === "new",
  ).length;
  return staying + joining;
}

/**
 * The plan once the server saved `sent`: each new task names the task it made,
 * the Backlog cards it took are in To Do, and the cards sent back are gone
 * from To Do. A later save then changes nothing that is already done. Tasks
 * the save left out (under a goal with no title, or past the cut) keep their
 * place.
 */
export function plannerAfterCommit(
  forward: PlannerForwardState,
  sent: Pick<PlannerCommitInput, "tasks" | "to_backlog">,
  created: Record<string, string>,
  question: string,
): PlannerForwardState {
  const refs = new Set(sent.tasks.map((task) => task.ref));
  const planned = new Set(
    sent.tasks.flatMap((task) => (task.task_id ? [task.task_id] : [])),
  );
  const moved = new Set(sent.to_backlog);
  return {
    ...forward,
    question,
    toBacklog: forward.toBacklog.filter(
      (id) => !moved.has(id) && !planned.has(id),
    ),
    tasks: forward.tasks.map((task) => {
      if (!refs.has(task.ref)) return task;
      const made = task.task_id ? undefined : created[task.ref];
      if (made) return { ...task, task_id: made, source: "todo" };
      return task.source === "backlog" ? { ...task, source: "todo" } : task;
    }),
  };
}

/** The cards that can still be added to a goal, by column. */
export function plannerPickableCards(
  forward: Pick<PlannerForwardState, "tasks" | "toBacklog">,
  board: Pick<PlannerBoardResponse, "columns">,
): Record<"todo" | "backlog" | "doing", PlannerBoardCard[]> {
  const named = namedCardIds(forward);
  const moved = new Set(forward.toBacklog);
  const free = (card: PlannerBoardCard) => !named.has(card.id);
  return {
    todo: board.columns.todo.filter(
      (card) => free(card) && !moved.has(card.id),
    ),
    backlog: [
      ...board.columns.todo.filter((card) => free(card) && moved.has(card.id)),
      ...board.columns.backlog.filter(free),
    ],
    doing: board.columns.doing.filter(free),
  };
}

/**
 * A card from the board joins a goal of the plan. A To Do card that was being
 * sent back to Backlog stays in To Do instead.
 */
export function plannerAddBoardTask(
  forward: PlannerForwardState,
  goalId: string,
  card: PlannerBoardCard,
  column: "todo" | "backlog" | "doing",
): PlannerForwardState {
  if (namedCardIds(forward).has(card.id)) return forward;
  const movedBack = forward.toBacklog.includes(card.id);
  return {
    ...forward,
    edited: true,
    toBacklog: movedBack
      ? forward.toBacklog.filter((id) => id !== card.id)
      : forward.toBacklog,
    tasks: [
      ...forward.tasks,
      {
        ref: `t-${card.id}`.slice(0, 64),
        goal_id: goalId,
        task_id: card.id,
        title: card.title,
        source: movedBack ? "todo" : column,
      },
    ],
  };
}

/** A new task joins a goal of the plan. */
export function plannerAddNewTask(
  forward: PlannerForwardState,
  goalId: string,
  title: string,
): PlannerForwardState {
  const text = title.trim().slice(0, 2000);
  if (!text) return forward;
  return {
    ...forward,
    edited: true,
    tasks: [
      ...forward.tasks,
      { ref: plannerNewId(), goal_id: goalId, title: text, source: "new" },
    ],
  };
}

/** The question for the next review: the plan's, else the one Look back chose. */
export function plannerPlanQuestion(
  forward: Pick<PlannerForwardState, "question">,
  back: Pick<PlannerBackState, "question">,
  review: Pick<Review, "week">,
): string {
  return forward.question ?? back.question ?? review.week?.question ?? "";
}

/** The conflict check's request. */
export function plannerCheckInput(
  forward: PlannerForwardState,
  today: string,
): PlannerAiCheckInput {
  return {
    today,
    goals: plannerNamedGoals(forward)
      .slice(0, 12)
      .map((goal) => ({
        id: goal.id,
        pillar: goal.pillar,
        title: goal.title.trim().slice(0, 1000),
        tasks: forward.tasks
          .filter((task) => task.goal_id === goal.id)
          .map((task) => task.title.trim().slice(0, 2000))
          .filter(Boolean)
          .slice(0, 20),
      })),
    settled: plannerSettledInput(forward),
  };
}

/** What changes the conflict check's answer: it runs again when this changes. */
export function plannerPlanSignature(forward: PlannerForwardState): string {
  return JSON.stringify([
    plannerNamedGoals(forward).map((goal) => [
      goal.id,
      goal.pillar,
      goal.title.trim(),
    ]),
    forward.tasks.map((task) => [task.goal_id, task.title]),
    forward.settled,
  ]);
}

/** The answered flags, as the check and the save read them. */
export function plannerSettledInput(
  forward: Pick<PlannerForwardState, "settled">,
) {
  return Object.entries(forward.settled)
    .slice(0, 24)
    .map(([flagId, entry]) =>
      entry.state === "rewritten" && entry.title?.trim()
        ? {
            flag_id: flagId,
            state: "rewritten" as const,
            title: entry.title.trim().slice(0, 1000),
          }
        : { flag_id: flagId, state: "kept" as const },
    );
}

/** The flags the check found, within the save's limits. */
export function plannerCheckFlags(
  flags: PlannerAiCheckResponse["flags"],
  forward: Pick<PlannerForwardState, "goals">,
): PlannerCommitInput["flags"] {
  const ids = new Set(forward.goals.map((goal) => goal.id));
  return flags
    .filter((flag) => flag.why.trim() && flag.with_label.trim())
    .slice(0, 5)
    .map((flag) => ({
      goal_id: flag.goal_id && ids.has(flag.goal_id) ? flag.goal_id : null,
      pillar: flag.pillar,
      with_goal_id: flag.with_goal_id?.trim()
        ? flag.with_goal_id.trim().slice(0, 256)
        : null,
      with_label: flag.with_label.trim().slice(0, 120),
      why: flag.why.trim().slice(0, 300),
    }));
}

/** The Look forward save. */
export function plannerCommitInput(
  forward: PlannerForwardState,
  question: string,
  flags: PlannerCommitInput["flags"],
  today: string,
): PlannerCommitInput {
  const goals = plannerNamedGoals(forward).slice(0, 12);
  const kept = new Set(goals.map((goal) => goal.id));
  const tasks = forward.tasks
    .filter((task) => kept.has(task.goal_id))
    .slice(0, 40);
  const planned = new Set(
    tasks.flatMap((task) => (task.task_id ? [task.task_id] : [])),
  );
  return {
    today,
    goals: goals.map((goal) => ({
      id: goal.id,
      pillar: goal.pillar,
      title: goal.title.trim().slice(0, 1000),
    })),
    tasks: tasks.map((task) =>
      task.task_id
        ? { ref: task.ref, goal_id: task.goal_id, task_id: task.task_id }
        : { ref: task.ref, goal_id: task.goal_id, title: task.title.trim() },
    ),
    to_backlog: forward.toBacklog
      .filter((id) => !planned.has(id))
      .slice(0, 100),
    question: question.trim() ? question.trim().slice(0, MAX_QUESTION) : null,
    settled: plannerSettledInput(forward),
    flags,
  };
}

// ---------------------------------------------------------------------------
// Saved state
// ---------------------------------------------------------------------------

export function plannerNewReviewState(review: Review): PlannerReviewState {
  return {
    v: 1,
    back: plannerNewBackState(review),
    forward: plannerNewForwardState(review),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TASK_SOURCES: readonly string[] = [
  "new",
  "todo",
  "backlog",
  "doing",
  "done",
] satisfies PlannerPlanTaskSource[];

/** A saved plan goal the page can still draw, or null to leave it out. */
function restoreGoal(value: unknown): PlannerPlanGoal | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    !(
      value.pillar === null ||
      plannerPillars.includes(value.pillar as PlannerPillar)
    )
  ) {
    return null;
  }
  return {
    id: value.id,
    pillar: value.pillar as PlannerPillar | null,
    title: value.title,
    ...(typeof value.fromSummary === "string" && DAY.test(value.fromSummary)
      ? { fromSummary: value.fromSummary }
      : {}),
    ...(value.custom === true ? { custom: true } : {}),
  };
}

function isPlanTask(value: unknown): value is PlannerPlanTask {
  if (!isRecord(value)) return false;
  return (
    typeof value.ref === "string" &&
    typeof value.goal_id === "string" &&
    typeof value.title === "string" &&
    (value.task_id === undefined || typeof value.task_id === "string") &&
    TASK_SOURCES.includes(value.source as string)
  );
}

const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * The state the page saved last time, checked enough to draw from; anything
 * that does not fit starts the review over. A model call that was cut off by
 * leaving the page runs again: its stage is kept and the page resumes it.
 */
export function plannerRestoreReviewState(
  saved: unknown,
  review: Review,
): PlannerReviewState {
  const fresh = plannerNewReviewState(review);
  if (!isRecord(saved) || saved.v !== 1) return fresh;
  const back = saved.back;
  const forward = saved.forward;
  if (!isRecord(back) || !isRecord(forward)) return fresh;
  if (
    !plannerReviewStages.includes(back.stage as PlannerReviewStage) ||
    !Array.isArray(back.log) ||
    !Array.isArray(back.conv) ||
    !Array.isArray(back.answers) ||
    back.answers.length !== PROMPT_COUNT ||
    !back.answers.every(isStrings) ||
    !isStrings(back.lastAnswer) ||
    !Array.isArray(forward.goals) ||
    !Array.isArray(forward.tasks)
  ) {
    return fresh;
  }
  const restored = saved as unknown as PlannerReviewState;
  const goals = forward.goals.map(restoreGoal).filter((goal) => goal !== null);
  const goalIds = new Set(goals.map((goal) => goal.id));
  const tasks = forward.tasks.filter(
    (task): task is PlannerPlanTask =>
      isPlanTask(task) && goalIds.has(task.goal_id),
  );
  return {
    v: 1,
    back: {
      ...fresh.back,
      ...restored.back,
      goalResults: {
        ...fresh.back.goalResults,
        ...(restored.back.goalResults ?? {}),
      },
      probes:
        Array.isArray(restored.back.probes) &&
        restored.back.probes.length === PROMPT_COUNT
          ? restored.back.probes
          : fresh.back.probes,
    },
    forward: {
      ...fresh.forward,
      ...restored.forward,
      goals,
      tasks,
      settled: isRecord(restored.forward.settled)
        ? restored.forward.settled
        : {},
      toBacklog: isStrings(restored.forward.toBacklog)
        ? restored.forward.toBacklog
        : [],
      step:
        typeof restored.forward.step === "number" &&
        restored.forward.step >= 1 &&
        restored.forward.step <= 4
          ? Math.floor(restored.forward.step)
          : 1,
    },
  };
}
