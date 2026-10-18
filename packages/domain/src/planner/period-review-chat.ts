import {
  FORK_PRODUCT_NAME,
  type PlannerPeriodHappened,
  type PlannerPeriodLevel,
  type PlannerPeriodOpeningResponse,
  type PlannerVerdictKind,
  plannerFormatScore,
  plannerMemoDayLabel,
  plannerPeriodLabel,
  plannerPillarNames,
  plannerReviewPrompts,
  plannerScoreFloors,
} from "@flaremo/contracts";
import type { PlannerPeriodContext } from "./period-review-context";
import {
  plannerPeriodContextBlock,
  plannerPeriodMemoMarker,
  plannerPeriodMemoTitle,
} from "./period-review-prompts";
import { plannerParseHappened } from "./review-happened";
import {
  type PlannerChatMessage,
  type PlannerCoachMode,
  type PlannerReviewAnswers,
  plannerExtractJson,
  plannerParseOpening,
} from "./review-prompts";

// The month and quarter reviews as a chat (fork-owned add-on,
// docs/planning-cockpit-period-review.md): the weekly review's Look back, the
// same steps and the same answer shapes, over a month or a quarter. The page
// runs it with the weekly review's own chat (review-back.tsx) and the routes
// answer like the weekly ones (planner-goals-api.ts), so these prompts mirror
// review-prompts.ts with the period's material and words.
//
// One addition: the opening also says what happened in the period, claim by
// claim, each with the owner's own words it rests on. The server checks every
// quote word for word against the period's rows (plannerVerifyQuote) and keeps
// only the claims it found, so the recap the owner reads is all receipts.

/** "month" or "quarter" (or "year"), as the prompts and the page say it. */
export function plannerPeriodWord(level: PlannerPeriodLevel): string {
  return level;
}

/** A weekly prompt for a period: "this week" becomes "this month". */
export function plannerPeriodPromptText(
  question: string,
  level: PlannerPeriodLevel,
): string {
  return question.replace(/\bthis week\b/g, `this ${plannerPeriodWord(level)}`);
}

function quote(text: string): string {
  return `"${text.replace(/\s+/g, " ").trim()}"`;
}

function nameOf(context: PlannerPeriodContext): string {
  return context.ownerName;
}

function labelOf(context: PlannerPeriodContext): string {
  return plannerPeriodLabel(context.level, context.periodStart);
}

/** The period's material: goals, every week's record, summary and diary. */
export function plannerPeriodChatContextBlock(
  context: PlannerPeriodContext,
): string {
  return plannerPeriodContextBlock(context, { diary: true, summaries: true });
}

const prompts = (level: PlannerPeriodLevel) =>
  plannerReviewPrompts.map((prompt) => ({
    label: prompt.label,
    question: plannerPeriodPromptText(prompt.question, level),
  }));

// ---------------------------------------------------------------------------
// Opening: what happened, with receipts, and the tap options
// ---------------------------------------------------------------------------

/** How many "what happened" claims the opening asks for, at most. */
export const PLANNER_PERIOD_HAPPENED_MAX = 8;

export function plannerPeriodOpeningMessages(
  context: PlannerPeriodContext,
): PlannerChatMessage[] {
  const name = nameOf(context);
  const word = plannerPeriodWord(context.level);
  const label = labelOf(context);
  const lastQuestion = context.previous?.question ?? null;
  const lastq = lastQuestion
    ? ` "lastq": [three answer options for last ${word}'s key question],`
    : "";
  return [
    {
      role: "system",
      content: `You prepare ${name}'s ${word} review. You say what happened, backed by ${name}'s own words, and write short candidate answers in ${name}'s voice for them to pick from or ignore. You reply with JSON only.`,
    },
    {
      role: "user",
      content: `You are preparing ${name}'s ${label} review. It runs like their weekly review, over the whole ${word}: ${name} first answers ${lastQuestion ? `last ${word}'s key question (${quote(lastQuestion)}), then ` : ""}judges the ${word}'s goals, then answers seven reflection prompts in their own words.

First, what happened in ${label}: up to ${PLANNER_PERIOD_HAPPENED_MAX} claims, the things that mattered most for the goals, one per line, plain and factual, at most 20 words each. Each claim needs a "quote": words copied exactly from one diary entry, health row, task note or week record below, at least six words, no edits, no ellipsis. A claim without words to back it is left out, so never write one you cannot quote. "pillar" is the objective it belongs to (of, work, ai, health) or null.

Then the recap: the ${word} in at most 35 plain, factual words.

Then candidate answers. Rules: first person, concrete, at most 14 words per option, grounded only in the material below. Where it is thin, make one of the three options an honest "not sure" or "nothing" answer. No praise, no judgement.

The seven prompts:
${prompts(context.level)
  .map((prompt, index) => `${index + 1}. ${prompt.question}`)
  .join("\n")}

Material:
${plannerPeriodChatContextBlock(context)}

Reply with only JSON in this shape, where each string is your text:
{"happened": [{"claim": string, "quote": string, "pillar": "of" or "work" or "ai" or "health" or null}], "recap": string,${lastq} "prompts": [seven arrays, one per prompt in order, each with three answer options]}`,
    },
  ];
}

/**
 * The opening as the page reads it: the weekly opening's drafts, and the
 * claims whose quote was found word for word in the period's rows. A claim
 * whose words were not found is dropped and counted.
 */
export function plannerParsePeriodOpening(
  raw: string,
  context: PlannerPeriodContext,
): PlannerPeriodOpeningResponse {
  return {
    ...plannerParseOpening(raw),
    ...plannerParseHappened(
      plannerExtractJson(raw) ?? {},
      context.raw,
      PLANNER_PERIOD_HAPPENED_MAX,
    ),
  };
}

// ---------------------------------------------------------------------------
// The answers so far, which the close, the coach and the memo read
// ---------------------------------------------------------------------------

const RESULT_WORDS = { met: "met", partial: "partly met", missed: "missed" };

function answersBlock(
  context: PlannerPeriodContext,
  answers: PlannerReviewAnswers,
): string {
  const name = nameOf(context);
  const word = plannerPeriodWord(context.level);
  const lastQuestion = context.previous?.question ?? null;
  const said = (list: readonly string[]) =>
    list.length ? list.map(quote).join(" then ") : "skipped";
  const goals = context.goals.map((goal) => {
    const found = answers.goalResults.find((entry) => entry.goalId === goal.id);
    const pillar = goal.pillar ? plannerPillarNames[goal.pillar] : "Other";
    return `- ${pillar}: ${quote(goal.title || goal.lines.map((line) => line.text).join("; "))}: ${
      found?.result ? RESULT_WORDS[found.result] : "not recorded"
    }`;
  });
  const notes = answers.coachNotes.slice(-10).map((note) => `- ${note}`);
  return [
    lastQuestion
      ? `Last ${word}'s key question: ${quote(lastQuestion)}\n${name}'s answer: ${said(answers.lastAnswer)}`
      : `There was no key question from last ${word}.`,
    "",
    goals.length
      ? `${labelOf(context)} goals, as ${name} judged them:\n${goals.join("\n")}`
      : `No ${word} goals were set for ${labelOf(context)}.`,
    "",
    `Reflection answers, in ${name}'s words:`,
    ...prompts(context.level).map(
      (prompt, index) =>
        `${index + 1}. ${prompt.label} (${prompt.question}): ${said(answers.answers[index] ?? [])}`,
    ),
    ...(notes.length ? ["", "Coach replies during the chat:", ...notes] : []),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Close: the period's scores and the trajectory
// ---------------------------------------------------------------------------

export function plannerPeriodCloseMessages(
  context: PlannerPeriodContext,
  answers: PlannerReviewAnswers,
): PlannerChatMessage[] {
  const name = nameOf(context);
  const word = plannerPeriodWord(context.level);
  const label = labelOf(context);
  const judge = context.goals.length
    ? `Judge Achievement against the ${label} goals and the results ${name} recorded.`
    : `No ${word} goals were set, so judge Achievement against the weekly goals and what the diary and tasks show ${name} set out to do and did.`;
  return [
    {
      role: "system",
      content: `You score ${name}'s ${word} against their own rubric and draft the trajectory. Scores are calibration, not judgement. You reply with JSON only.`,
    },
    {
      role: "user",
      content: `Score ${name}'s ${label} as a whole and draft the trajectory into next ${word}, from their review answers below and the material. The weekly scores are in the material: read them as evidence, don't average them. Follow ${name}'s own rubric. Catching yourself earns Authenticity, hiding a miss costs it.

Authenticity (1 to 5, 0.5 steps): 5 surfaced uncomfortable truths before being asked; 4 honest when prompted, named what they were tempted to hide; 3 some avoidance or rationalization; 2 blind spots left alone, edited the story to look better; 1 hid misses.
Achievement (1 to 5, 0.5 steps): 5 exceeded all goals, stretch included; 4 main goals met, some stretch; 3 most goals met, some misses; 2 significant misses on main goals; 1 priorities not delivered. ${judge}
The floors are Authenticity ${plannerFormatScore(plannerScoreFloors.auth)} and Achievement ${plannerFormatScore(plannerScoreFloors.ach)}. Score what the answers show, not the floors.

Trajectory: pattern, risk and opportunity, one sentence each, about the ${word} as a whole (a pattern names the weeks it shows in); three candidate key questions for next ${word}'s review, each starting "Did I"; three verdicts in exactly these formats: "Continue. {specific reason}." / "Pivot toward {X}, away from {Y}. {evidence}." / "Pause for {question}. Without answering this, next ${word} risks {specific cost}."; and the verdict you recommend.

${answersBlock(context, answers)}

Material:
${plannerPeriodChatContextBlock(context)}

Reply with only JSON in this shape, where each string is your text and each number is your score:
{"scores": {"auth": number, "ach": number, "auth_evidence": "one sentence: the basis for Authenticity", "ach_evidence": "one sentence: the basis for Achievement"}, "trajectory": {"pattern": string, "risk": string, "opportunity": string, "questions": [three strings], "verdicts": {"continue": string, "pivot": string, "pause": string}, "recommended": "continue" or "pivot" or "pause"}}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// The coach
// ---------------------------------------------------------------------------

export function plannerPeriodCoachSystem(
  context: PlannerPeriodContext,
  mode: PlannerCoachMode,
): string {
  const name = nameOf(context);
  const word = plannerPeriodWord(context.level);
  const lastQuestion = context.previous?.question ?? null;
  const tail = {
    free: "For this reply you may ask one probing question if the answer is vague.",
    force:
      'For this reply do not ask a question: acknowledge in one or two sentences and end with @@ {"advance": true}.',
    chat: 'The seven prompts are done. Answer what they said in one to three sentences and end with @@ {"advance": false}.',
  }[mode];
  return `You are the coach in ${name}'s ${labelOf(context)} review. It is their weekly review over the whole ${word}: ${
    lastQuestion
      ? `first last ${word}'s key question (${quote(lastQuestion)}), then `
      : ""
  }seven reflection prompts asked one at a time. ${name} answers in their own words, the coach probes once if an answer is vague, and gaps between plan and reality are data, not verdicts.

How to reply:
- One to three short sentences in plain words. No headings, lists, emojis or praise.
- Reflect one specific thing they said. When the diary, tasks or weekly records hold something that bears on it, point at it: an entry, a number or a name, exactly as the material has it, with the day in brackets. Then either ask one probing question (what specifically, who, which number, what got in the way) or acknowledge it.
- Think in weeks, not days: when something repeats across weeks, or one week went differently, say which weeks.
- Never answer a prompt for them and never summarize the whole ${word}.
- Last ${word}'s key question: if the answer is "partly", "no" or vague, ask once what specifically happened.
- Prompt 6 (blindspot) is the coaching moment: don't accept the first answer; offer one candidate blindspot from the material and name the bias it looks like (confirmation, sunk cost, anchoring, complexity or recency).
- Prompt 7 (tempted to hide): probe once to confirm.
- After your sentences, end with one last line, exactly @@ {"advance": true} when the answer is specific enough to move to the next prompt, or @@ {"advance": false} when you asked a question and want their answer.

Material from ${name}'s ${word}:
${plannerPeriodChatContextBlock(context)}

${tail}`;
}

export function plannerPeriodCoachChatMessages(
  context: PlannerPeriodContext,
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
    { role: "system", content: plannerPeriodCoachSystem(context, mode) },
    ...merged,
  ];
}

// ---------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------

export type PlannerPeriodChatMemoRequest = PlannerReviewAnswers & {
  reviewedOn: string;
  scores: { auth: number; ach: number };
  drafted?: { auth: number; ach: number } | null;
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

const VERDICT_NAMES: Record<PlannerVerdictKind, string> = {
  continue: "Continue",
  pivot: "Pivot",
  pause: "Pause",
};

function verdictLine(
  verdict: PlannerPeriodChatMemoRequest["verdict"],
  recommended: PlannerVerdictKind,
): string {
  if (!verdict)
    return `**Verdict:** — (suggested: ${VERDICT_NAMES[recommended]})`;
  const text = verdict.text.trim();
  return `**Verdict:** ${text || VERDICT_NAMES[verdict.kind]}`;
}

/**
 * The memo's parts, as the weekly memo has them: the skeleton, the rules and
 * the evening's material. The general agent gets them in its memo step.
 */
export function plannerPeriodChatMemoParts(
  context: PlannerPeriodContext,
  request: PlannerPeriodChatMemoRequest,
): { system: string; template: string; rules: string; material: string } {
  const name = nameOf(context);
  const word = plannerPeriodWord(context.level);
  const label = labelOf(context);
  const kind = word[0]?.toUpperCase() + word.slice(1);
  const drafted = request.drafted;
  const changed =
    drafted &&
    (drafted.auth !== request.scores.auth || drafted.ach !== request.scores.ach)
      ? drafted
      : null;
  const lastQuestion = context.previous?.question ?? null;
  const goalsSentence = context.goals.length
    ? `${label} had ${context.goals.length} ${word} goals, judged in the review`
    : `no ${word} goals were set, so the ${word} is judged on its weekly goals and what the diary and tasks show`;
  return {
    system: `You write ${name}'s ${word} review memo in Markdown, in the shape of their weekly summaries over a bigger period. You use only the material given and keep ${name}'s own words.`,
    template: `Write ${name}'s ${label} review memo in Markdown. Text in parentheses below is an instruction for you, not text to copy.

${plannerPeriodMemoTitle(context.level, context.periodStart)}

## Review status and sources

(Two sentences: created in the ${FORK_PRODUCT_NAME} ${word} review on ${plannerMemoDayLabel(request.reviewedOn)}, over ${context.weeks.length} weeks (${context.periodStart} to ${context.periodEnd}); ${goalsSentence}.)

## Executive Summary

(One paragraph of three or four sentences about the ${word} as a whole.)

## 1. What happened

(The ${word}'s claims below, one bullet each, each with its quote and day exactly as given, in this form: - Claim. "quote" (day).${lastQuestion ? ` Then ${name}'s answer to last ${word}'s key question.` : ""})

## 2. Guided Reflection Prompts

${prompts(context.level)
  .map((prompt) => `- **${prompt.label}:** (answer)`)
  .join("\n")}

## 3. Goal Progress Update

(One bullet per ${word} goal: the result ${name} gave it and one line of evidence from the material. Then, per objective with anything behind it, one line: what moved and what didn't.)

| | Score | Basis |
| --- | --- | --- |
| Authenticity | ${plannerFormatScore(request.scores.auth)} | (one sentence) |
| Achievement | ${plannerFormatScore(request.scores.ach)} | (one sentence) |
| Gap | ${plannerFormatScore(Math.abs(request.scores.auth - request.scores.ach))} | |

## Trajectory into next ${word}

**Pattern.** (text)

**Risk.** (text)

**Opportunity.** (text)

**Key question for next ${word}:** ${request.question?.trim() || "—"}

${verdictLine(request.verdict, request.recommended)}

${plannerPeriodMemoMarker(context.level, context.periodStart)}`,
    rules: `Rules:
- Use only the material below. Don't invent events, names or numbers.
- Be specific: name the weeks, days, people and numbers the material gives, and quote ${name}'s own words, copied exactly inside quotation marks.
- "What happened" uses only the claims listed under "What happened" below, with their quotes unchanged. Leave a claim out rather than change its quote.
- Write "Skipped." for a skipped prompt and "None stated." for a part with nothing behind it.
- Pattern, Risk and Opportunity: start from the drafts below and keep their meaning${
      changed ? ", unless it contradicts the scores" : ""
    }.${
      changed
        ? `\n- ${name} changed the drafted scores, and the drafts below were written for the old ones. Write the basis of each changed score afresh from the evidence, and keep nothing from the drafts that contradicts ${name}'s scores.`
        : ""
    }
- Copy the scores table's numbers, the Key question line, the Verdict line and the last line exactly as given.
- No preamble: start with the H1 line. Under 1,100 words.
- ${kind} reviews sit next to the weekly summaries in ${name}'s memos: keep the headings exactly as given.`,
    material: `${answersBlock(context, request)}

Scores ${name} set for the ${word}: Authenticity ${plannerFormatScore(request.scores.auth)}, Achievement ${plannerFormatScore(request.scores.ach)}.${
      changed
        ? `\nDrafted scores, which the drafts were written for: Authenticity ${plannerFormatScore(changed.auth)}, Achievement ${plannerFormatScore(changed.ach)}.`
        : ""
    }
Authenticity basis (draft): ${request.drafts.auth_evidence || "none"}
Achievement basis (draft): ${request.drafts.ach_evidence || "none"}
Pattern (draft): ${request.drafts.pattern || "none"}
Risk (draft): ${request.drafts.risk || "none"}
Opportunity (draft): ${request.drafts.opportunity || "none"}`,
  };
}

/** What happened, as the memo copies it: claim, quote and day. */
export function plannerPeriodHappenedLines(
  happened: readonly PlannerPeriodHappened[],
): string {
  if (happened.length === 0) return "What happened: (no claims were backed)";
  return [
    "What happened (each claim's quote was found word for word in the rows):",
    ...happened.map(
      (entry) => `- ${entry.claim} ${quote(entry.quote)} (${entry.source_day})`,
    ),
  ].join("\n");
}

export function plannerPeriodChatMemoMessages(
  context: PlannerPeriodContext,
  request: PlannerPeriodChatMemoRequest,
  happened: readonly PlannerPeriodHappened[],
): PlannerChatMessage[] {
  const parts = plannerPeriodChatMemoParts(context, request);
  return [
    { role: "system", content: parts.system },
    {
      role: "user",
      content: `${parts.template}\n\n${parts.rules}\n\nMaterial:\n${plannerPeriodHappenedLines(happened)}\n\n${parts.material}\n\nThe ${plannerPeriodWord(context.level)}:\n${plannerPeriodContextBlock(context, { diary: false, summaries: true })}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// The general agent (docs/fork-general-agent.md), for a period
// ---------------------------------------------------------------------------

/** The agent session's key in place of a week's Monday: "month:2026-10-01". */
export function plannerPeriodAgentKey(
  level: PlannerPeriodLevel,
  periodStart: string,
): string {
  return `${level}:${periodStart}`;
}
