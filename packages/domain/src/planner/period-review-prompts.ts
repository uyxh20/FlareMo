import {
  type PlannerPeriodAnswers,
  type PlannerPeriodGoal,
  type PlannerPeriodGoalResultInput,
  type PlannerPeriodLevel,
  type PlannerPeriodStep,
  type PlannerVerdictKind,
  plannerFormatScore,
  plannerPeriodLabel,
  plannerPeriodSteps,
  plannerPillarNames,
  plannerPillars,
  plannerScoreFloors,
} from "@flaremo/contracts";
import {
  type PlannerPeriodContext,
  type PlannerPeriodWeekContext,
  plannerVerifyQuote,
} from "./period-review-context";
import {
  type PlannerChatMessage,
  plannerExtractJson,
  plannerReadingRules,
} from "./review-prompts";

// The prompts of the month, quarter and year reviews and the parsers of their
// answers (fork-owned add-on, docs/planning-cockpit-period-review.md). Pure
// functions of the context: the routes call the model and the page decides.
// Every answer that makes a claim must carry a quote, and the server checks
// each quote word for word against the raw rows (plannerVerifyQuote): what
// the model says "holds" is its opinion, `verified` is the check.
//
// The model is never asked for goals: the goal walk, the fold, the verdict,
// the forecast and next period's goals are the owner's. It reads, checks,
// counts and quotes.

function goalLine(goal: PlannerPeriodGoal): string {
  const lines = goal.lines
    .map(
      (line) =>
        `${line.struck ? "[struck] " : ""}${line.text}${line.note ? ` (${line.note})` : ""}`,
    )
    .join("; ");
  const who = goal.pillar ? plannerPillarNames[goal.pillar] : "Theme";
  const result = goal.result ? ` [result: ${goal.result}]` : "";
  const tasks = goal.tasks_linked
    ? ` [tasks: ${goal.tasks_done} of ${goal.tasks_linked} done]`
    : "";
  return `- ${who}: ${goal.title || "(untitled)"}${lines ? ` — ${lines}` : ""}${result}${tasks} (id ${goal.id})`;
}

function goalsBlock(
  label: string,
  goals: readonly PlannerPeriodGoal[],
): string {
  if (goals.length === 0) return `${label}: none written`;
  return `${label}:\n${goals.map(goalLine).join("\n")}`;
}

function scoreLine(week: PlannerPeriodWeekContext): string {
  const auth = week.auth === null ? "–" : plannerFormatScore(week.auth);
  const ach = week.ach === null ? "–" : plannerFormatScore(week.ach);
  return `W${week.number} ${auth}/${ach}`;
}

function weekHeader(week: PlannerPeriodWeekContext): string {
  const parts = [
    `Week ${week.number} (from ${week.week_start})`,
    `scores ${scoreLine(week).replace(/^W\d+ /, "")}`,
    `${week.entries} entries`,
    `${week.health_rows} health rows (${week.training} training days, ${week.breath_days} breath days, ${week.nights_out} nights out)`,
    `${week.tasks_done} tasks done`,
    `goals ${week.goal_results.met} met / ${week.goal_results.partial} partial / ${week.goal_results.missed} missed / ${week.goal_results.open} open`,
  ];
  return parts.join(" · ");
}

/** The diary entries of one week as the model reads them. */
function weekDiary(week: PlannerPeriodWeekContext): string {
  if (week.diary.length === 0) return "(no diary entries)";
  return week.diary
    .map((entry) => `[${entry.at.slice(0, 10)}] ${entry.text}`)
    .join("\n");
}

function weekRows(week: PlannerPeriodWeekContext): string {
  const lines: string[] = [];
  if (week.question)
    lines.push(`Key question set for this week: ${week.question}`);
  if (week.verdict) lines.push(`Verdict: ${week.verdict}`);
  if (week.goals.length) {
    lines.push(
      `Week goals: ${week.goals
        .map(
          (goal) =>
            `${goal.pillar ? plannerPillarNames[goal.pillar] : "Theme"}: ${goal.title}${goal.result ? ` [${goal.result}]` : ""}`,
        )
        .join("; ")}`,
    );
  }
  if (week.done.length) lines.push(`Tasks done: ${week.done.join("; ")}`);
  if (week.health.length) lines.push(`Health rows: ${week.health.join(" | ")}`);
  return lines.join("\n");
}

/** The level's goal cascade, scores and counts: the head of every prompt. */
export function plannerPeriodContextBlock(
  context: PlannerPeriodContext,
  options: { diary?: boolean; summaries?: boolean } = {},
): string {
  const label = plannerPeriodLabel(context.level, context.periodStart);
  const childLabel =
    context.level === "quarter"
      ? "Month goals in the quarter"
      : "Quarter goals in the year";
  const lines = [
    plannerReadingRules(context.ownerName).replace(/this week/g, "this period"),
    "",
    `Period: ${label}, ${context.periodStart} to ${context.periodEnd}, ${context.weeks.length} weeks.`,
    `North star: ${context.northStar ? context.northStar.title : "not written"}`,
    goalsBlock(`${label} goals`, context.goals),
    ...(context.level === "month"
      ? []
      : [goalsBlock(childLabel, context.childGoals)]),
    `Weekly scores, Authenticity/Achievement (floors ${plannerFormatScore(plannerScoreFloors.auth)} and ${plannerFormatScore(plannerScoreFloors.ach)}): ${context.weeks.map(scoreLine).join(", ")}`,
    context.previous
      ? `Last period (${plannerPeriodLabel(context.level, context.previous.periodStart)}): verdict "${context.previous.verdict ?? "none"}"; forecast "${context.previous.forecast ?? "none"}".`
      : "Last period: no review recorded.",
    `Memories: ${context.memories.created} created in the period, ${context.memories.revised} older ones revised.`,
    "",
    ...context.weeks.flatMap((week) => [
      `## ${weekHeader(week)}`,
      weekRows(week),
      ...(options.summaries && week.summary
        ? [`Weekly summary (a claim, not evidence):\n${week.summary}`]
        : []),
      ...(options.diary ? [`Diary entries:\n${weekDiary(week)}`] : []),
      "",
    ]),
  ];
  return lines.join("\n");
}

function stepOf(level: PlannerPeriodLevel, id: string): PlannerPeriodStep {
  return (
    plannerPeriodSteps[level].find((step) => step.id === id) ??
    (plannerPeriodSteps[level][0] as PlannerPeriodStep)
  );
}

function answersBlock(
  level: PlannerPeriodLevel,
  answers: PlannerPeriodAnswers,
): string {
  const parts = plannerPeriodSteps[level].flatMap((step) => {
    const lines = (answers[step.id] ?? []).filter((line) => line.trim());
    return lines.length ? [`${step.title}:\n${lines.join("\n")}`] : [];
  });
  return parts.length ? parts.join("\n\n") : "(nothing answered yet)";
}

// ---------------------------------------------------------------------------
// The checks: summaries against the diary (month, step 1)
// ---------------------------------------------------------------------------

export function plannerPeriodChecksMessages(
  context: PlannerPeriodContext,
): PlannerChatMessage[] {
  const name = context.ownerName;
  return [
    {
      role: "system",
      content: `You check ${name}'s weekly summaries against the diary entries they were written from. You quote the diary word for word and never paraphrase a quote. You answer with one JSON object and nothing else.`,
    },
    {
      role: "user",
      content: `${plannerPeriodContextBlock(context, { diary: true, summaries: true })}

For each week that has a summary, pick up to three claims the summary makes about what happened, and for each one find the diary words it rests on. Then list up to five things the diary entries record that no summary mentions.

Rules:
- "quote" is copied word for word from a diary entry or a health row above: at least four words, no edits, no ellipsis. If no words support a claim, set "holds" to false and "quote" to "".
- Count nothing. Name things.
- Say "holds": true only when the quote supports the claim as written.

Answer with exactly this JSON:
{"checks":[{"week_start":"YYYY-MM-DD","claim":"...","quote":"...","holds":true}],"left_out":[{"quote":"...","why":"one sentence"}]}`,
    },
  ];
}

export function plannerParsePeriodChecks(
  raw: string,
  context: PlannerPeriodContext,
): {
  checks: Array<{
    week_start: string;
    claim: string;
    quote: string;
    holds: boolean;
    verified: boolean;
    source_id: string | null;
  }>;
  left_out: Array<{
    quote: string;
    why: string;
    verified: boolean;
    source_id: string | null;
  }>;
} {
  const parsed = plannerExtractJson(raw) ?? {};
  const weeks = new Set(context.weeks.map((week) => week.week_start));
  const text = (value: unknown, max: number) =>
    typeof value === "string" ? value.trim().slice(0, max) : "";
  const checks = (Array.isArray(parsed.checks) ? parsed.checks : [])
    .slice(0, 40)
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const weekStart = text(entry.week_start, 10);
      const claim = text(entry.claim, 600);
      if (!claim) return [];
      const quote = text(entry.quote, 600);
      const check = quote
        ? plannerVerifyQuote(quote, context.raw)
        : { verified: false, source: null };
      return [
        {
          week_start: weeks.has(weekStart)
            ? weekStart
            : (context.weeks[0]?.week_start ?? weekStart),
          claim,
          quote,
          holds: entry.holds === true && check.verified,
          verified: check.verified,
          source_id: check.source
            ? `${check.source.source}:${check.source.id}`
            : null,
        },
      ];
    });
  const leftOut = (Array.isArray(parsed.left_out) ? parsed.left_out : [])
    .slice(0, 12)
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const quote = text(entry.quote, 600);
      const why = text(entry.why, 400);
      if (!quote) return [];
      const check = plannerVerifyQuote(quote, context.raw);
      return [
        {
          quote,
          why,
          verified: check.verified,
          source_id: check.source
            ? `${check.source.source}:${check.source.id}`
            : null,
        },
      ];
    });
  return { checks, left_out: leftOut };
}

// ---------------------------------------------------------------------------
// Themes: two readers (quarter, step 2)
// ---------------------------------------------------------------------------

/** One reader's prompt; `reader` 1 and 2 get the weeks in opposite order, so neither leads the other. */
export function plannerPeriodThemesMessages(
  context: PlannerPeriodContext,
  reader: 1 | 2,
): PlannerChatMessage[] {
  const name = context.ownerName;
  const weeks = reader === 1 ? context.weeks : [...context.weeks].reverse();
  const flipped = { ...context, weeks };
  return [
    {
      role: "system",
      content: `You are reader ${reader} of two who read ${name}'s diary for one period independently. You name the themes that run through several weeks, each with one quote copied word for word. You answer with one JSON object and nothing else.`,
    },
    {
      role: "user",
      content: `${plannerPeriodContextBlock(flipped, { diary: true })}

Name between three and seven themes that recur across at least two different weeks of this period. A theme is two to five plain words (for example "late nights after shipping", "training only when travelling stops"). For each theme give the objective it belongs to (of, work, ai, health, or null) and one quote copied word for word from a diary entry or health row above, at least four words, no edits.

Answer with exactly this JSON:
{"themes":[{"label":"...","pillar":"work","quote":"..."}]}`,
    },
  ];
}

function themeKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 3)
    .sort()
    .join(" ");
}

function themesShare(left: string, right: string): number {
  const a = new Set(left.split(" ").filter(Boolean));
  const b = new Set(right.split(" ").filter(Boolean));
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common += 1;
  return common / Math.min(a.size, b.size);
}

type ParsedTheme = {
  label: string;
  pillar: "of" | "work" | "ai" | "health" | null;
  quote: string;
};

function parseThemes(raw: string): ParsedTheme[] {
  const parsed = plannerExtractJson(raw) ?? {};
  return (Array.isArray(parsed.themes) ? parsed.themes : [])
    .slice(0, 10)
    .flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const entry = item as Record<string, unknown>;
      const label =
        typeof entry.label === "string" ? entry.label.trim().slice(0, 80) : "";
      if (!label) return [];
      const pillar = plannerPillars.find((p) => p === entry.pillar) ?? null;
      const quote =
        typeof entry.quote === "string" ? entry.quote.trim().slice(0, 600) : "";
      return [{ label, pillar, quote }];
    });
}

/**
 * Merges two readers' themes: a theme both named (half their long words in
 * common) counts for two readers; `agreement` is the share of merged themes
 * both named. Each quote is checked against the raw rows.
 */
export function plannerMergePeriodThemes(
  first: string,
  second: string,
  context: PlannerPeriodContext,
): {
  themes: Array<{
    label: string;
    pillar: "of" | "work" | "ai" | "health" | null;
    quote: string;
    verified: boolean;
    source_id: string | null;
    readers: number;
  }>;
  agreement: number;
} {
  const one = parseThemes(first);
  const two = parseThemes(second);
  const used = new Set<number>();
  const merged = one.map((theme) => {
    const key = themeKey(theme.label);
    const index = two.findIndex(
      (other, i) =>
        !used.has(i) && themesShare(key, themeKey(other.label)) >= 0.5,
    );
    if (index >= 0) used.add(index);
    return { ...theme, readers: index >= 0 ? 2 : 1 };
  });
  two.forEach((theme, index) => {
    if (!used.has(index)) merged.push({ ...theme, readers: 1 });
  });
  const themes = merged.map((theme) => {
    const check = theme.quote
      ? plannerVerifyQuote(theme.quote, context.raw)
      : { verified: false, source: null };
    return {
      label: theme.label,
      pillar: theme.pillar,
      quote: theme.quote,
      verified: check.verified,
      source_id: check.source
        ? `${check.source.source}:${check.source.id}`
        : null,
      readers: theme.readers,
    };
  });
  const both = themes.filter((theme) => theme.readers === 2).length;
  return {
    themes: themes.sort((a, b) => b.readers - a.readers),
    agreement: themes.length ? both / themes.length : 0,
  };
}

// ---------------------------------------------------------------------------
// The coach: one step's reply
// ---------------------------------------------------------------------------

const STEP_GUIDANCE: Record<string, string> = {
  "month:check":
    "Read the weekly summaries against the diary entries. Name what the summaries left out and what they claim without support. Quote the diary.",
  "month:questions":
    "Take each week's key question and say, from the next week's entries and tasks, whether it was answered, dodged or left open. Quote the words that show it.",
  "month:goals":
    "For each month goal point, say which raw rows (entries, health rows, tasks done) would justify striking it. Where no row supports a strike, say so. The owner strikes; you only hand them the receipts.",
  "month:fold":
    "The owner writes one sentence per objective. For each sentence they give, say whether the material supports it; flag any claim with no entry, row or task behind it. Do not write the sentences for them.",
  "month:verdict":
    "The owner chooses continue, pivot or pause and writes one forecast sentence for next month. Grade last month's forecast against this month's rows (held, partly, missed) with a quote. Do not pick the verdict.",
  "quarter:goals":
    "Walk each quarter goal: list the receipts per point (entries, health rows, tasks done, month goal results). Where the owner's grade is above its receipts, say so plainly. Do not decide keep, rephrase or kill.",
  "quarter:themes":
    "Discuss the themes the two readers found, which they agreed on, and what each rests on. Ask which the owner recognises.",
  "quarter:scores":
    "Read the thirteen weeks of scores: trend or noise, weeks under the floors, the spread. Tie turns to dated entries. Copy numbers exactly; never total them.",
  "quarter:premortem":
    "The owner imagines next quarter failed and says why. List this quarter's misses from the rows (missed goals, weeks under the floors, dodged questions) as the material for that.",
  "quarter:close":
    "The owner writes the close-out sentence and next quarter's goals. Check the sentence against the rows; never suggest a goal.",
  "year:calendar":
    "Walk the weeks: for each, one line from its own entries. The owner marks repeat or never again. Do not mark for them.",
  "year:goals":
    "For each year goal, lay out twelve months of receipts: quarter and month goal results, tasks done, health totals as rows show them. The owner grades.",
  "year:northstar":
    "Set out what the year's rows proved and disproved about the north star. Ask whether it still holds. Do not rewrite it.",
  "year:beliefs":
    "Compare memories created in the year with older ones revised in it. Name what changed. Ask what the owner believed in January that they do not now.",
  "year:sentence":
    "The owner writes the year sentence and next year's four goals. Check the sentence against the rows; never suggest a goal.",
};

export function plannerPeriodCoachMessages(
  context: PlannerPeriodContext,
  input: {
    step: string;
    messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
    answers: PlannerPeriodAnswers;
  },
): PlannerChatMessage[] {
  const name = context.ownerName;
  const step = stepOf(context.level, input.step);
  const label = plannerPeriodLabel(context.level, context.periodStart);
  const guidance =
    STEP_GUIDANCE[`${context.level}:${step.id}`] ??
    "Answer from the material only.";
  const wantsDiary = step.id !== "scores";
  const wantsSummaries = context.level === "month";
  return [
    {
      role: "system",
      content: `You are the reader in ${name}'s ${label} review: a careful colleague who reads the raw rows (diary entries, health rows, tasks done, week records) and never the digested versions when the rows are there. You quote ${name}'s own words with the day in brackets. You never total things up, never invent, never suggest goals, verdicts or marks: those are ${name}'s. Plain prose, short paragraphs, no headings, under 180 words unless listing receipts. Address ${name} by name once at most.`,
    },
    {
      role: "user",
      content: `${plannerPeriodContextBlock(context, { diary: wantsDiary, summaries: wantsSummaries })}

Answers so far in this review:
${answersBlock(context.level, input.answers)}

This step: ${step.title}. The question: ${step.question}
What to do: ${guidance}`,
    },
    ...input.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
    ...(input.messages.length === 0
      ? [{ role: "user" as const, content: "Begin." }]
      : []),
  ];
}

// ---------------------------------------------------------------------------
// The memo
// ---------------------------------------------------------------------------

/** "# Month review: October 2026" etc. */
export function plannerPeriodMemoTitle(
  level: PlannerPeriodLevel,
  periodStart: string,
): string {
  const kind =
    level === "month" ? "Month" : level === "quarter" ? "Quarter" : "Year";
  return `# ${kind} review: ${plannerPeriodLabel(level, periodStart)}`;
}

/** The marker line that ties the memo to its period, kept at the end. */
export function plannerPeriodMemoMarker(
  level: PlannerPeriodLevel,
  periodStart: string,
): string {
  return `_${level} review · ${periodStart}_`;
}

export function plannerPeriodMemoMessages(
  context: PlannerPeriodContext,
  request: {
    answers: PlannerPeriodAnswers;
    goalResults: readonly PlannerPeriodGoalResultInput[];
    verdict: { kind: PlannerVerdictKind; text: string } | null;
    forecast: string | null;
  },
): PlannerChatMessage[] {
  const name = context.ownerName;
  const label = plannerPeriodLabel(context.level, context.periodStart);
  const byId = new Map(
    [...context.goals, ...context.childGoals].map((goal) => [goal.id, goal]),
  );
  const results = request.goalResults
    .flatMap((entry) => {
      const goal = byId.get(entry.goal_id);
      return goal
        ? [
            `- ${goal.pillar ? plannerPillarNames[goal.pillar] : "Theme"}: ${goal.title} — ${entry.result ?? "not judged"}${entry.decision ? `, ${entry.decision}` : ""}${entry.note ? ` (${entry.note})` : ""}`,
          ]
        : [];
    })
    .join("\n");
  const sections =
    context.level === "month"
      ? `## What the summaries left out
## Key questions, graded
## Month goals
(one line per goal: the result and its receipt)
## The fold
(${name}'s one sentence per objective, as written)
## Verdict
## Forecast for next month`
      : context.level === "quarter"
        ? `## Goal walk
(one line per goal: grade, decision, receipts)
## Themes
## Scores
## Pre-mortem
## Close-out
## Next quarter's goals`
        : `## Weeks to repeat, weeks never again
## Year goals, graded
## North star
## Belief ledger
## The year in one page
## Next year's goals`;
  return [
    {
      role: "system",
      content: `You write ${name}'s ${label} review memo in Markdown from their own answers and the rows. You keep ${name}'s words, quote the diary with the day in brackets, write nothing the material does not hold, and never add goals, verdicts or marks that ${name} did not give.`,
    },
    {
      role: "user",
      content: `${plannerPeriodContextBlock(context, { diary: false, summaries: false })}

${name}'s answers in this review:
${answersBlock(context.level, request.answers)}

Goal results ${name} recorded:
${results || "(none)"}

Verdict: ${request.verdict ? `${request.verdict.kind}${request.verdict.text ? ` — ${request.verdict.text}` : ""}` : "not chosen"}
Forecast: ${request.forecast ?? "not written"}

Write the memo with exactly these headings, in this order, under the title. Under each heading, ${name}'s own words first (fix typos only), then at most two short lines of receipts from the rows. Leave a heading with "(not answered)" when there is nothing. End with the marker line exactly as given.

${plannerPeriodMemoTitle(context.level, context.periodStart)}

${sections}

${plannerPeriodMemoMarker(context.level, context.periodStart)}`,
    },
  ];
}

/** The memo from its title on, with the marker line kept at its end. */
export function plannerCleanPeriodMemo(
  raw: string,
  level: PlannerPeriodLevel,
  periodStart: string,
): string {
  let memo = raw.replace(/\r/g, "").trim();
  memo = memo
    .replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, "$1")
    .trim();
  const title = memo.search(/^#\s+(Month|Quarter|Year) review\b/m);
  if (title > 0) memo = memo.slice(title);
  memo = memo.replace(/\n```\s*$/, "").trim();
  const marker = plannerPeriodMemoMarker(level, periodStart);
  if (!memo.includes(marker)) memo = `${memo}\n\n${marker}`;
  return memo;
}

/**
 * How much of the saved memo is the owner's own: the share of its non-empty
 * lines that are not in the draft, 0 to 1. Null without a draft.
 */
export function plannerRewriteRate(
  draft: string | null,
  saved: string,
): number | null {
  if (!draft) return null;
  const lines = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line && !line.startsWith("#"));
  const draftLines = new Set(lines(draft));
  const savedLines = lines(saved);
  if (savedLines.length === 0) return null;
  const own = savedLines.filter((line) => !draftLines.has(line)).length;
  return Math.round((own / savedLines.length) * 100) / 100;
}
