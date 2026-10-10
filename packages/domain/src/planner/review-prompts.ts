import {
  FORK_PRODUCT_NAME,
  type PlannerGoalDto,
  type PlannerGoalLevel,
  type PlannerPillar,
  type PlannerVerdictKind,
  plannerAddDays,
  plannerDiaryLine,
  plannerDiaryMarker,
  plannerFormatScore,
  plannerIsoWeekOf,
  plannerKeyQuestionLine,
  plannerMemoDayLabel,
  plannerMemoPillarHeadings,
  plannerMemoTitle,
  plannerPillarNames,
  plannerPillars,
  plannerReviewPrompts,
  plannerScoreFloors,
  plannerScoresTable,
  plannerSnapScore,
  plannerVerdictKinds,
  plannerVerdictLine,
  plannerWeekCode,
} from "@flaremo/contracts";
import type { PlannerReviewContext } from "./review-context";

// The weekly review's prompts and the parsers for what comes back (fork-owned
// add-on, docs/planning-cockpit-goals-review.md). Pure functions: the Worker sends
// the messages to the model and hands the raw text back here.
//
// The model drafts and probes; it never decides. Every draft is an option the
// owner can take or ignore, the scores follow the owner's own rubric, and the
// conflict check only flags. A reply that cannot be read falls back to the page's
// own drafts, so a weak model degrades the review instead of breaking it.

export type PlannerChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const SHORT_MONTHS = MONTHS.map((month) => month.slice(0, 3));
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function day(dayKey: string) {
  const [year, month, date] = dayKey.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return { year, month: month - 1, date };
}

/** "5–11 October 2026" */
export function plannerWeekRangeText(weekStart: string): string {
  const first = day(weekStart);
  const last = day(plannerAddDays(weekStart, 6));
  return first.month === last.month
    ? `${first.date}–${last.date} ${MONTHS[last.month]} ${last.year}`
    : `${first.date} ${MONTHS[first.month]} – ${last.date} ${MONTHS[last.month]} ${last.year}`;
}

/** "Week 41 (5–11 October 2026)" */
function weekName(weekStart: string): string {
  return `Week ${plannerIsoWeekOf(weekStart).week} (${plannerWeekRangeText(weekStart)})`;
}

function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim()}"`;
}

/** A goal in one line: its title, its lines, and what is open about it. */
function goalText(goal: PlannerGoalDto): string {
  const lines = goal.lines
    .map(
      (line) =>
        `${line.struck ? "[struck] " : ""}${line.text}${line.note ? ` (${line.note})` : ""}`,
    )
    .join("; ");
  const body = [goal.title, lines].filter(Boolean).join(": ");
  const state =
    goal.status === "contested"
      ? ` [contested${goal.note ? `: ${goal.note}` : ""}]`
      : goal.status === "draft"
        ? " [draft, not confirmed]"
        : goal.status === "closed"
          ? " [closed]"
          : "";
  const result = goal.result ? ` [result: ${goal.result}]` : "";
  return `${body}${state}${result}`;
}

function goalsByPillar(goals: readonly PlannerGoalDto[]): string {
  const theme = goals.filter((goal) => goal.pillar === null);
  const parts = [
    ...theme.map((goal) => `Theme: ${goalText(goal)}`),
    ...plannerPillars.flatMap((pillar) =>
      goals
        .filter((goal) => goal.pillar === pillar)
        .map((goal) => `${plannerPillarNames[pillar]}: ${goalText(goal)}`),
    ),
  ];
  return parts.length ? parts.join(" | ") : "none written";
}

function scoreText(score: {
  weekStart: string;
  auth: number | null;
  ach: number | null;
}): string {
  const code = plannerWeekCode(score.weekStart);
  return score.auth !== null && score.ach !== null
    ? `${code} ${plannerFormatScore(score.auth)}/${plannerFormatScore(score.ach)}`
    : `${code} not scored`;
}

function diaryDay(at: string): string {
  const key = at.slice(0, 10);
  const { year, month, date } = day(key);
  const weekday = new Date(Date.UTC(year, month, date)).getUTCDay();
  return `${WEEKDAYS[weekday]} ${date} ${SHORT_MONTHS[month]}`;
}

/** The context block every prompt ends with. */
export function plannerReviewContextBlock(
  context: PlannerReviewContext,
): string {
  const quarter =
    Math.floor(day(plannerAddDays(context.weekStart, 3)).month / 3) + 1;
  const month = MONTHS[day(plannerAddDays(context.weekStart, 3)).month];
  const year = day(plannerAddDays(context.weekStart, 3)).year;
  const lines = [
    `North star: ${context.northStar ? goalText(context.northStar) : "not written"}`,
    `Year goals ${year}: ${goalsByPillar(context.yearGoals)}`,
    `Q${quarter} ${year} goals: ${goalsByPillar(context.quarterGoals)}`,
    `${month} goals: ${goalsByPillar(context.monthGoals)}`,
    `Weekly scores, Authenticity/Achievement (floors ${plannerFormatScore(plannerScoreFloors.auth)} and ${plannerFormatScore(plannerScoreFloors.ach)}): ${
      context.scores.length
        ? context.scores.map(scoreText).join(", ")
        : "none recorded"
    }`,
    context.weekGoals.length
      ? `${weekName(context.weekStart)} weekly goals: ${goalsByPillar(context.weekGoals)}`
      : `${weekName(context.weekStart)}: no weekly goals were set.`,
    `Last week's review question: ${context.lastQuestion ? quote(context.lastQuestion) : "none"}`,
    `Tasks done this week: ${context.tasks.done.join("; ") || "none"}`,
    `Doing: ${context.tasks.doing.join("; ") || "none"}`,
    `To Do: ${context.tasks.todo.join("; ") || "none"}`,
  ];
  if (context.openFlags.length) {
    lines.push(
      `Open clashes from earlier checks: ${context.openFlags
        .map((flag) => `${flag.label}: ${flag.why}`)
        .join("; ")}`,
    );
  }
  if (context.previousSummary) {
    lines.push(
      "",
      "Last week's summary, as written then:",
      "<<<",
      context.previousSummary,
      ">>>",
    );
  }
  if (context.diary.length) {
    lines.push(
      "",
      `${context.ownerName}'s diary entries this week, oldest first, in their own words:`,
      ...context.diary.map((entry) => `[${diaryDay(entry.at)}] ${entry.text}`),
    );
  } else {
    lines.push("", "No diary entries were written this week.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Opening: the recap and the tap options
// ---------------------------------------------------------------------------

export function plannerOpeningMessages(
  context: PlannerReviewContext,
): PlannerChatMessage[] {
  const name = context.ownerName;
  const lastQuestion = context.lastQuestion
    ? `Last week's key question: ${quote(context.lastQuestion)}\n\n`
    : "";
  return [
    {
      role: "system",
      content: `You prepare ${name}'s Sunday weekly review. You write short candidate answers in ${name}'s voice for them to pick from or ignore. You reply with JSON only.`,
    },
    {
      role: "user",
      content: `You are preparing ${name}'s weekly review, the Look back part, for ${weekName(context.weekStart)}. ${name} first answers ${context.lastQuestion ? "last week's key question, then " : ""}seven reflection prompts, in their own words. Your job is to draft short candidate answers they can pick from or ignore.

Rules: first person, concrete, at most 14 words per option, grounded only in the context below. Where the context is thin, make one of the three options an honest "not sure" or "nothing" answer. No praise, no judgement.

${lastQuestion}The seven prompts:
${plannerReviewPrompts.map((prompt, index) => `${index + 1}. ${prompt.question}`).join("\n")}

Also write a recap: the week in at most 35 plain, factual words.

Context:
${plannerReviewContextBlock(context)}

Reply with only JSON in this shape, where each string is your text:
{"recap": string, "lastq": [three answer options for last week's key question], "prompts": [seven arrays, one per prompt in order, each with three answer options]}`,
    },
  ];
}

export type PlannerOpeningDraft = {
  recap: string;
  lastq: string[];
  prompts: string[][];
};

const text = (value: unknown): string | null =>
  typeof value === "string" && value.replace(/\s+/g, " ").trim()
    ? value.replace(/\s+/g, " ").trim()
    : null;

const options = (value: unknown, min = 2): string[] | null => {
  const list = (Array.isArray(value) ? value : [])
    .map(text)
    .filter((item): item is string => item !== null)
    .map((item) => item.slice(0, 240))
    .slice(0, 3);
  return list.length >= min ? list : null;
};

/**
 * The first JSON object in a model's reply: the reply may wrap it in a code
 * fence or a sentence, and may leave a trailing comma. Null when there is none.
 */
export function plannerExtractJson(
  raw: string,
): Record<string, unknown> | null {
  if (!raw) return null;
  const unfenced = raw.replace(/```(?:json)?/gi, "");
  const start = unfenced.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < unfenced.length; index += 1) {
    const character = unfenced[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        const body = unfenced.slice(start, index + 1);
        for (const candidate of [body, body.replace(/,\s*([}\]])/g, "$1")]) {
          try {
            const parsed = JSON.parse(candidate) as unknown;
            if (
              parsed &&
              typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // Try the repaired body next.
          }
        }
        return null;
      }
    }
  }
  return null;
}

/** What the model drafted for the opening; missing parts are empty. */
export function plannerParseOpening(raw: string): PlannerOpeningDraft {
  const parsed = plannerExtractJson(raw) ?? {};
  const prompts = Array.isArray(parsed.prompts) ? parsed.prompts : [];
  return {
    recap: text(parsed.recap)?.slice(0, 400) ?? "",
    lastq: options(parsed.lastq) ?? [],
    prompts: plannerReviewPrompts.map((_, index) => {
      const entry = prompts[index] as unknown;
      return (
        options(
          Array.isArray(entry)
            ? entry
            : entry && typeof entry === "object"
              ? (entry as { options?: unknown }).options
              : null,
        ) ?? []
      );
    }),
  };
}

// ---------------------------------------------------------------------------
// The answers so far, which the close, the memo and the coach read
// ---------------------------------------------------------------------------

export type PlannerReviewAnswers = {
  lastAnswer: readonly string[];
  answers: ReadonlyArray<readonly string[]>;
  goalResults: ReadonlyArray<{
    goalId: string;
    result: "met" | "partial" | "missed" | null;
  }>;
  coachNotes: readonly string[];
};

const RESULT_WORDS = { met: "met", partial: "partly met", missed: "missed" };

function answersBlock(
  context: PlannerReviewContext,
  answers: PlannerReviewAnswers,
): string {
  const said = (list: readonly string[]) =>
    list.length ? list.map(quote).join(" then ") : "skipped";
  const goals = context.weekGoals.map((goal) => {
    const found = answers.goalResults.find((entry) => entry.goalId === goal.id);
    const pillar = goal.pillar ? plannerPillarNames[goal.pillar] : "Other";
    return `- ${pillar}: ${quote(goal.title || goal.lines.map((line) => line.text).join("; "))}: ${
      found?.result ? RESULT_WORDS[found.result] : "not recorded"
    }`;
  });
  const notes = answers.coachNotes.slice(-10).map((note) => `- ${note}`);
  return [
    context.lastQuestion
      ? `Last week's key question: ${quote(context.lastQuestion)}\n${context.ownerName}'s answer: ${said(answers.lastAnswer)}`
      : "There was no key question from last week.",
    "",
    goals.length
      ? `Last week's goals, as ${context.ownerName} judged them:\n${goals.join("\n")}`
      : "No weekly goals were set for this week.",
    "",
    `Reflection answers, in ${context.ownerName}'s words:`,
    ...plannerReviewPrompts.map(
      (prompt, index) =>
        `${index + 1}. ${prompt.label} (${prompt.question}): ${said(answers.answers[index] ?? [])}`,
    ),
    ...(notes.length ? ["", "Coach replies during the chat:", ...notes] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Close: scores and the trajectory
// ---------------------------------------------------------------------------

export function plannerCloseMessages(
  context: PlannerReviewContext,
  answers: PlannerReviewAnswers,
): PlannerChatMessage[] {
  const name = context.ownerName;
  const thisWeek = plannerWeekCode(context.weekStart);
  const nextWeek = plannerWeekCode(context.planWeek);
  const judge = context.weekGoals.length
    ? `Judge Achievement against the ${thisWeek} goals and the results ${name} recorded.`
    : `No ${thisWeek} goals were set, so judge Achievement against last week's Next Steps in the summary and the tasks done.`;
  return [
    {
      role: "system",
      content: `You score ${name}'s week against their own rubric and draft the trajectory. Scores are calibration, not judgement. You reply with JSON only.`,
    },
    {
      role: "user",
      content: `Score ${name}'s ${weekName(context.weekStart)} and draft the trajectory into ${nextWeek}, from their review answers below and the context. Follow ${name}'s own rubric. Catching yourself earns Authenticity, hiding a miss costs it.

Authenticity (1 to 5, 0.5 steps): 5 surfaced uncomfortable truths before being asked; 4 honest when prompted, named what they were tempted to hide; 3 some avoidance or rationalization; 2 blind spots left alone, edited the story to look better; 1 hid misses.
Achievement (1 to 5, 0.5 steps): 5 exceeded all goals, stretch included; 4 main goals met, some stretch; 3 most goals met, some misses; 2 significant misses on main goals; 1 priorities not delivered. ${judge}
The floors are Authenticity ${plannerFormatScore(plannerScoreFloors.auth)} and Achievement ${plannerFormatScore(plannerScoreFloors.ach)}. Score what the answers show, not the floors.

Trajectory: pattern, risk and opportunity, one sentence each; three candidate key questions for the ${nextWeek} review, each starting "Did I"; three verdicts in exactly these formats: "Continue. {specific reason}." / "Pivot toward {X}, away from {Y}. {evidence}." / "Pause for {question}. Without answering this, next week risks {specific cost}."; and the verdict you recommend.

${answersBlock(context, answers)}

Context:
${plannerReviewContextBlock(context)}

Reply with only JSON in this shape, where each string is your text and each number is your score:
{"scores": {"auth": number, "ach": number, "auth_evidence": "one sentence: the basis for Authenticity", "ach_evidence": "one sentence: the basis for Achievement"}, "trajectory": {"pattern": string, "risk": string, "opportunity": string, "questions": [three strings], "verdicts": {"continue": string, "pivot": string, "pause": string}, "recommended": "continue" or "pivot" or "pause"}}`,
    },
  ];
}

export type PlannerCloseDraft = {
  scores: {
    auth: number | null;
    ach: number | null;
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

/** What the model drafted for the close; anything unreadable is empty or null. */
export function plannerParseClose(raw: string): PlannerCloseDraft {
  const parsed = plannerExtractJson(raw) ?? {};
  const scores = (parsed.scores ?? {}) as Record<string, unknown>;
  const trajectory = (parsed.trajectory ?? {}) as Record<string, unknown>;
  const verdicts = (trajectory.verdicts ?? {}) as Record<string, unknown>;
  const recommended = plannerVerdictKinds.find(
    (kind) => kind === trajectory.recommended,
  );
  return {
    scores: {
      auth: plannerSnapScore(scores.auth),
      ach: plannerSnapScore(scores.ach),
      auth_evidence: text(scores.auth_evidence)?.slice(0, 400) ?? "",
      ach_evidence: text(scores.ach_evidence)?.slice(0, 400) ?? "",
    },
    trajectory: {
      pattern: text(trajectory.pattern)?.slice(0, 400) ?? "",
      risk: text(trajectory.risk)?.slice(0, 400) ?? "",
      opportunity: text(trajectory.opportunity)?.slice(0, 400) ?? "",
      questions: options(trajectory.questions, 1) ?? [],
      verdicts: {
        continue: text(verdicts.continue)?.slice(0, 400) ?? "",
        pivot: text(verdicts.pivot)?.slice(0, 400) ?? "",
        pause: text(verdicts.pause)?.slice(0, 400) ?? "",
      },
      recommended: recommended ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// The coach: one reply in the chat
// ---------------------------------------------------------------------------

export type PlannerCoachMode = "free" | "force" | "chat";

/** The coach's instructions, sent before the chat so far. */
export function plannerCoachSystem(
  context: PlannerReviewContext,
  mode: PlannerCoachMode,
): string {
  const name = context.ownerName;
  const tail = {
    free: "For this reply you may ask one probing question if the answer is vague.",
    force:
      'For this reply do not ask a question: acknowledge in one or two sentences and end with @@ {"advance": true}.',
    chat: 'The seven prompts are done. Answer what they said in one to three sentences and end with @@ {"advance": false}.',
  }[mode];
  return `You are the coach in ${name}'s weekly review, the Look back part, for ${weekName(context.weekStart)}. It follows ${name}'s own method: ${
    context.lastQuestion
      ? `first last week's key question (${quote(context.lastQuestion)}), then `
      : ""
  }seven reflection prompts asked one at a time. ${name} answers in their own words, the coach probes once if an answer is vague, and gaps between plan and reality are data, not verdicts.

How to reply:
- One to three short sentences in plain words. No headings, lists, emojis or praise.
- Reflect one specific thing they said, then either ask one probing question (what specifically, who, which number, what got in the way) or acknowledge it.
- Never answer a prompt for them and never summarize the whole week.
- Last week's key question: if the answer is "partly", "no" or vague, ask once what specifically happened.
- Prompt 6 (blindspot) is the coaching moment: don't accept the first answer; offer one candidate blindspot from the context and name the bias it looks like (confirmation, sunk cost, anchoring, complexity or recency).
- Prompt 7 (tempted to hide): probe once to confirm.
- After your sentences, end with one last line, exactly @@ {"advance": true} when the answer is specific enough to move to the next prompt, or @@ {"advance": false} when you asked a question and want their answer.
${tail}

Context from ${name}'s goals system:
${plannerReviewContextBlock(context)}`;
}

/**
 * The coach's messages: its instructions, then the chat so far with neighbours
 * of the same role merged, starting with the owner. Only the last 40 turns go.
 */
export function plannerCoachMessages(
  context: PlannerReviewContext,
  mode: PlannerCoachMode,
  chat: ReadonlyArray<{ role: "user" | "assistant"; content: string }>,
): PlannerChatMessage[] {
  let history = chat.slice(-40);
  while (history.length && history[0]?.role !== "user")
    history = history.slice(1);
  const merged: PlannerChatMessage[] = [];
  for (const message of history) {
    const last = merged.at(-1);
    if (last && last.role === message.role) {
      last.content = `${last.content}\n\n${message.content}`;
    } else {
      merged.push({ role: message.role, content: message.content });
    }
  }
  return [
    { role: "system", content: plannerCoachSystem(context, mode) },
    ...merged,
  ];
}

// ---------------------------------------------------------------------------
// The summary memo
// ---------------------------------------------------------------------------

export type PlannerMemoRequest = PlannerReviewAnswers & {
  reviewedOn: string;
  scores: { auth: number; ach: number };
  question: string | null;
  verdict: { kind: PlannerVerdictKind; text: string } | null;
  recommended: PlannerVerdictKind;
  drafts: {
    auth_evidence: string;
    ach_evidence: string;
    pattern: string;
    risk: string;
    opportunity: string;
  };
};

export function plannerMemoMessages(
  context: PlannerReviewContext,
  request: PlannerMemoRequest,
): PlannerChatMessage[] {
  const name = context.ownerName;
  const code = plannerWeekCode(context.weekStart);
  const next = plannerWeekCode(context.planWeek);
  const goalsSentence = context.weekGoals.length
    ? `${code} had ${context.weekGoals.length} weekly goals, judged in the review`
    : `no ${code} goals were set in advance, so the week is judged against last week's Next Steps`;
  const pillarSections = plannerPillars
    .map((pillar) => {
      if (pillar === "of") {
        return [
          plannerMemoPillarHeadings.of,
          plannerScoresTable({
            weekStart: context.weekStart,
            scores: request.scores,
            authBasis: "(one sentence)",
            achBasis: "(one sentence)",
          }),
          "",
          "- **Evidence:** (text)",
          "- **Learnings:** (text)",
          "- **Blockers:** (text)",
          "- **Next Steps:** (text)",
        ].join("\n");
      }
      return `${plannerMemoPillarHeadings[pillar]}\n(the same four bullets)`;
    })
    .join("\n\n");
  return [
    {
      role: "system",
      content: `You write ${name}'s weekly summary memo in Markdown, in the exact format of their past weekly summaries. You use only the material given and keep ${name}'s own words.`,
    },
    {
      role: "user",
      content: `Write ${name}'s ${code} weekly summary in Markdown. It is saved next to their past weekly summaries, so copy that format exactly: the headings and their order, the bullet labels, the scores table and the bold run-in labels in the trajectory. Keep ${name}'s own words for the reflection answers (fix typos only) and quote their words where it helps. Text in parentheses below is an instruction for you, not text to copy.

${plannerMemoTitle(context.weekStart)}

## Review status and sources

(Two or three sentences: created in the ${FORK_PRODUCT_NAME} weekly review on ${plannerMemoDayLabel(request.reviewedOn)}; ${goalsSentence}.)

## Executive Summary

(One paragraph of three or four sentences.)

## 1. High-Level Summary

(Two or three short paragraphs.${context.lastQuestion ? ` Include ${name}'s answer to last week's key question.` : ""})

## 2. Guided Reflection Prompts

${plannerReviewPrompts.map((prompt) => `- **${prompt.label}:** (answer)`).join("\n")}

## 3. Goal Progress Update

${pillarSections}

## Trajectory into ${next}

**Pattern.** (text)

**Risk.** (text)

**Opportunity.** (text)

${plannerKeyQuestionLine(context.weekStart, request.question)}

${plannerVerdictLine(request.verdict, request.recommended)}

## 4. Raw Logs for this Week

${plannerDiaryLine(context.weekStart)}

${plannerDiaryMarker(context.weekStart)}

Rules:
- Use only the material below. Don't invent events, names or numbers.
- Write "Skipped." for a skipped prompt and "None stated." for a bullet with nothing behind it.
- Each Next Steps bullet is one concrete step for ${next} in at most 15 words; it becomes the suggested weekly goal for that objective.
- Pattern, Risk and Opportunity: start from the drafts below and keep their meaning.
- Copy the Gap row, the Key question line, the Verdict line and the two Raw Logs lines exactly as given.
- No preamble: start with the H1 line. Under 900 words.

Material:
${answersBlock(context, request)}

Scores: Authenticity ${plannerFormatScore(request.scores.auth)}, Achievement ${plannerFormatScore(request.scores.ach)}, Gap ${plannerFormatScore(Math.abs(request.scores.auth - request.scores.ach))}.
Authenticity basis (draft): ${request.drafts.auth_evidence || "none"}
Achievement basis (draft): ${request.drafts.ach_evidence || "none"}
Pattern (draft): ${request.drafts.pattern || "none"}
Risk (draft): ${request.drafts.risk || "none"}
Opportunity (draft): ${request.drafts.opportunity || "none"}

Context:
${plannerReviewContextBlock(context)}`,
    },
  ];
}

/**
 * A memo as the model wrote it, made safe to save: anything before the title
 * goes, a code fence around the whole memo goes (or the closing one left when the
 * stream dropped the opening one with the preamble), and the diary marker is
 * added when the model dropped it.
 */
export function plannerCleanMemo(raw: string, weekStart: string): string {
  let memo = raw.replace(/\r/g, "").trim();
  memo = memo
    .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, "$1")
    .trim();
  const title = memo.search(/^#\s+Week\b/m);
  if (title > 0) memo = memo.slice(title);
  memo = memo.replace(/\n```\s*$/, "").trim();
  const marker = plannerDiaryMarker(weekStart);
  if (!memo.includes(marker)) memo = `${memo}\n\n${marker}`;
  return memo;
}

/**
 * The memo's streamed text from its title on: a preamble or an opening code
 * fence before the first "# " line is dropped. When no title shows up in the
 * first 600 characters, the text is passed on as it came.
 */
export function plannerMemoStreamFilter(): {
  push(piece: string): string;
  finish(): string;
} {
  const fence = /^\s*```[a-z]*[^\S\n]*\n/i;
  let started = false;
  let held = "";
  return {
    push(piece) {
      if (started) return piece;
      held += piece;
      const title = held.search(/^#[^\S\n]/m);
      if (title >= 0 || held.length > 600) {
        started = true;
        const out = title >= 0 ? held.slice(title) : held.replace(fence, "");
        held = "";
        return out;
      }
      return "";
    },
    finish() {
      return started ? "" : held.replace(fence, "");
    },
  };
}

/**
 * The coach's streamed reply without its control line. Text goes on as it
 * arrives; from "@@" on it is held back and read at the end for whether the
 * review moves to the next prompt. `force` always moves on and `chat` never
 * does; in `free` mode a reply with no control line moves on unless it ends
 * with a question.
 */
export function plannerCoachStreamFilter(mode: PlannerCoachMode): {
  push(piece: string): string;
  finish(): { tail: string; advance: boolean };
} {
  let held = "";
  let control: string | null = null;
  let said = "";
  return {
    push(piece) {
      if (control !== null) {
        control += piece;
        return "";
      }
      held += piece;
      const at = held.indexOf("@@");
      let out: string;
      if (at >= 0) {
        control = held.slice(at + 2);
        out = held.slice(0, at);
        held = "";
      } else {
        // A lone "@" may be the start of "@@": keep it until the next piece.
        const keep = held.endsWith("@") ? 1 : 0;
        out = held.slice(0, held.length - keep);
        held = held.slice(held.length - keep);
      }
      said += out;
      return out;
    },
    finish() {
      const tail = control === null ? held : "";
      said += tail;
      const found =
        control === null ? null : /"advance"\s*:\s*(true|false)/.exec(control);
      const advance =
        mode === "force"
          ? true
          : mode === "chat"
            ? false
            : found
              ? found[1] === "true"
              : !said.trim().endsWith("?");
      return { tail, advance };
    },
  };
}

// ---------------------------------------------------------------------------
// The conflict check
// ---------------------------------------------------------------------------

export type PlannerCheckGoal = {
  id: string;
  pillar: PlannerPillar | null;
  title: string;
  tasks: readonly string[];
};

export type PlannerCheckSettled = {
  label: string;
  why: string;
  state: "kept" | "rewritten";
  title?: string;
};

export function plannerCheckMessages(
  context: PlannerReviewContext,
  plan: readonly PlannerCheckGoal[],
  settled: readonly PlannerCheckSettled[],
): PlannerChatMessage[] {
  const name = context.ownerName;
  const planText = plan
    .map(
      (goal) =>
        `- ${goal.pillar ? `${plannerPillarNames[goal.pillar]} (${goal.pillar})` : "No objective"}: ${quote(goal.title)}. Tasks: ${goal.tasks.join("; ") || "none"}`,
    )
    .join("\n");
  const reviewed = [
    ...settled.map(
      (entry) =>
        `- ${entry.label}: ${entry.why} ${entry.state === "kept" ? "Kept for now." : `Rewritten to ${quote(entry.title ?? "")}.`}`,
    ),
    ...context.keptFlags.map(
      (flag) =>
        `- ${flag.label}: ${flag.why} Kept for now in an earlier review.`,
    ),
  ];
  return [
    {
      role: "system",
      content: `You check ${name}'s weekly plan against their goal cascade. You only flag clashes; you never suggest fixes. You reply with JSON only.`,
    },
    {
      role: "user",
      content: `Check ${name}'s plan for ${weekName(context.planWeek)} against their goal cascade. Flag at most three real clashes where a weekly goal or its tasks pull against a year goal, a quarter goal, a month goal, the north star, or another weekly goal. Flag only: do not suggest rewrites or fixes. If nothing clashes, return an empty list.

The plan:
${planText || "- no goals"}

Goal cascade:
North star: ${context.northStar ? goalText(context.northStar) : "not written"}
Year: ${goalsByPillar(context.yearGoals)}
Quarter: ${goalsByPillar(context.quarterGoals)}
Month: ${goalsByPillar(context.monthGoals)}
${reviewed.length ? `\n${name} already reviewed these clashes. Don't flag them again:\n${reviewed.join("\n")}\n` : ""}
Reply with only JSON: {"flags":[{"goal":"of|work|ai|health","with_level":"north_star|year|quarter|month|week","with_goal":"of|work|ai|health or null for the north star","why":"one plain sentence, at most 20 words"}]}`,
    },
  ];
}

export type PlannerCheckFlag = {
  goal_id: string | null;
  pillar: PlannerPillar | null;
  with_goal_id: string | null;
  with_label: string;
  why: string;
};

const LEVELS: readonly PlannerGoalLevel[] = [
  "north_star",
  "year",
  "quarter",
  "month",
  "week",
];

/** The short name of a goal a flag points at: "North star", "Q4 · Work". */
export function plannerFlagLabel(
  level: PlannerGoalLevel,
  pillar: PlannerPillar | null,
  periodStart: string | null,
): string {
  if (level === "north_star") return "North star";
  const name = pillar ? plannerPillarNames[pillar] : "Theme";
  if (level === "year") return `Year · ${name}`;
  const start = periodStart ? day(periodStart) : null;
  if (level === "quarter") {
    return `${start ? `Q${Math.floor(start.month / 3) + 1}` : "Quarter"} · ${name}`;
  }
  if (level === "month") {
    return `${start ? MONTHS[start.month] : "Month"} · ${name}`;
  }
  return `Week · ${name}`;
}

/**
 * The flags the model found, tied to real goals: each names one of the plan's
 * goals by objective and one goal of the cascade by level and objective. At most
 * three; one that names nothing it can be tied to keeps only its label.
 */
export function plannerParseCheck(
  raw: string,
  context: PlannerReviewContext,
  plan: readonly PlannerCheckGoal[],
): PlannerCheckFlag[] {
  const parsed = plannerExtractJson(raw) ?? {};
  const list = Array.isArray(parsed.flags) ? parsed.flags : [];
  const cascade: Record<string, readonly PlannerGoalDto[]> = {
    north_star: context.northStar ? [context.northStar] : [],
    year: context.yearGoals,
    quarter: context.quarterGoals,
    month: context.monthGoals,
  };
  const out: PlannerCheckFlag[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const why = text(record.why)?.slice(0, 300);
    if (!why) continue;
    const pillar =
      plannerPillars.find((value) => value === record.goal) ?? null;
    const goal = pillar
      ? plan.find((item) => item.pillar === pillar)
      : undefined;
    const level =
      LEVELS.find((value) => value === record.with_level) ??
      (typeof record.with === "string" && /north/i.test(record.with)
        ? "north_star"
        : null);
    const withPillar =
      plannerPillars.find((value) => value === record.with_goal) ?? null;
    let withGoal: PlannerGoalDto | PlannerCheckGoal | undefined;
    if (level === "week") {
      withGoal = plan.find(
        (item) => item.pillar === withPillar && item.id !== goal?.id,
      );
    } else if (level) {
      const candidates = cascade[level] ?? [];
      withGoal =
        level === "north_star"
          ? candidates[0]
          : candidates.find((item) => item.pillar === withPillar);
    }
    const label = level
      ? plannerFlagLabel(
          level,
          withPillar,
          withGoal && "period_start" in withGoal ? withGoal.period_start : null,
        )
      : (text(record.with)?.slice(0, 120) ?? "Another goal");
    out.push({
      goal_id: goal?.id ?? null,
      pillar,
      with_goal_id: withGoal?.id ?? null,
      with_label: label,
      why,
    });
    if (out.length === 3) break;
  }
  return out;
}
