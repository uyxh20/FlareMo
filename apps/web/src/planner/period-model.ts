import {
  type PlannerEvidenceInput,
  type PlannerForecastGrade,
  type PlannerGoalDecision,
  type PlannerGoalResult,
  type PlannerPeriodAiChecksResponse,
  type PlannerPeriodAiThemesResponse,
  type PlannerPeriodLevel,
  type PlannerPeriodReviewResponse,
  type PlannerPeriodWeek,
  type PlannerVerdictKind,
  type PlannerWeekMark,
  plannerForecastGrades,
  plannerGoalDecisions,
  plannerGoalResults,
  plannerPeriodSteps,
  plannerScoreFloors,
  plannerVerdictKinds,
  plannerWeekMarks,
} from "@flaremo/contracts";

// The period review page's own state and the pure functions on it
// (fork-owned add-on, docs/planning-cockpit-period-review.md). The page saves
// the state as it goes (`PATCH /period-review/:level/:period/state`) and
// restores it from the server's copy, so everything here must survive JSON
// and a careless hand: `plannerRestorePeriodState` checks every field.

export type PlannerPeriodChat = Array<{
  role: "user" | "assistant";
  content: string;
}>;

export type PlannerPeriodGoalEntry = {
  result: PlannerGoalResult | null;
  decision: PlannerGoalDecision | null;
  note: string;
};

export type PlannerPeriodState = {
  step: number;
  /** The owner's lines per step id. */
  answers: Record<string, string[]>;
  /** The chat with the reader per step id. */
  chat: Record<string, PlannerPeriodChat>;
  checks: PlannerPeriodAiChecksResponse | null;
  themes: PlannerPeriodAiThemesResponse | null;
  goals: Record<string, PlannerPeriodGoalEntry>;
  weekMarks: Record<string, PlannerWeekMark>;
  evidence: PlannerEvidenceInput[];
  verdict: { kind: PlannerVerdictKind; text: string } | null;
  forecast: string;
  previousGrade: PlannerForecastGrade | null;
  memo: string | null;
  draftMemo: string | null;
  memoBy: "model" | "page" | null;
  memoSaved: boolean;
};

export function plannerEmptyPeriodState(): PlannerPeriodState {
  return {
    step: 1,
    answers: {},
    chat: {},
    checks: null,
    themes: null,
    goals: {},
    weekMarks: {},
    evidence: [],
    verdict: null,
    forecast: "",
    previousGrade: null,
    memo: null,
    draftMemo: null,
    memoBy: null,
    memoSaved: false,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
const str = (value: unknown, max = 20_000): string =>
  typeof value === "string" ? value.slice(0, max) : "";
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/** The saved state, checked field by field; anything odd falls back to empty. */
export function plannerRestorePeriodState(
  saved: Record<string, unknown>,
  review: PlannerPeriodReviewResponse,
): PlannerPeriodState {
  const empty = plannerEmptyPeriodState();
  const steps = plannerPeriodSteps[review.level].map((step) => step.id);
  const answers: Record<string, string[]> = {};
  if (isRecord(saved.answers)) {
    for (const id of steps) {
      const lines = strings(saved.answers[id]).map((line) =>
        line.slice(0, 12_000),
      );
      if (lines.length) answers[id] = lines;
    }
  }
  const chat: Record<string, PlannerPeriodChat> = {};
  if (isRecord(saved.chat)) {
    for (const id of steps) {
      const list = Array.isArray(saved.chat[id]) ? saved.chat[id] : [];
      const messages = (list as unknown[]).flatMap((item) => {
        if (!isRecord(item)) return [];
        const role: "user" | "assistant" | null =
          item.role === "user" || item.role === "assistant" ? item.role : null;
        const content = str(item.content, 12_000);
        return role && content ? [{ role, content }] : [];
      });
      if (messages.length) chat[id] = messages.slice(-60);
    }
  }
  const goals: Record<string, PlannerPeriodGoalEntry> = {};
  const known = new Set([
    ...review.goals.map((goal) => goal.id),
    ...review.child_goals.map((goal) => goal.id),
  ]);
  if (isRecord(saved.goals)) {
    for (const [id, value] of Object.entries(saved.goals)) {
      if (!known.has(id) || !isRecord(value)) continue;
      goals[id] = {
        result: plannerGoalResults.find((r) => r === value.result) ?? null,
        decision:
          plannerGoalDecisions.find((d) => d === value.decision) ?? null,
        note: str(value.note, 2_000),
      };
    }
  }
  const weekMarks: Record<string, PlannerWeekMark> = {};
  const weeks = new Set(review.weeks.map((week) => week.week_start));
  if (isRecord(saved.weekMarks)) {
    for (const [monday, mark] of Object.entries(saved.weekMarks)) {
      const found = plannerWeekMarks.find((m) => m === mark);
      if (weeks.has(monday) && found) weekMarks[monday] = found;
    }
  }
  const evidence = (Array.isArray(saved.evidence) ? saved.evidence : [])
    .flatMap((item: unknown) => {
      if (!isRecord(item)) return [];
      const claim = str(item.claim, 600).trim();
      const quote = str(item.quote, 600).trim();
      const pillar: "of" | "work" | "ai" | "health" | null =
        item.pillar === "of" ||
        item.pillar === "work" ||
        item.pillar === "ai" ||
        item.pillar === "health"
          ? item.pillar
          : null;
      return claim && quote ? [{ pillar, claim, quote }] : [];
    })
    .slice(0, 200);
  const verdictKind = isRecord(saved.verdict)
    ? plannerVerdictKinds.find(
        (k) => k === (saved.verdict as Record<string, unknown>).kind,
      )
    : undefined;
  const step =
    typeof saved.step === "number"
      ? Math.min(5, Math.max(1, Math.round(saved.step)))
      : 1;
  // Results already recorded on the goals start the walk.
  for (const goal of [...review.goals, ...review.child_goals]) {
    if (!goals[goal.id] && goal.result) {
      goals[goal.id] = { result: goal.result, decision: null, note: "" };
    }
  }
  return {
    ...empty,
    step,
    answers,
    chat,
    checks:
      isRecord(saved.checks) && Array.isArray(saved.checks.checks)
        ? (saved.checks as unknown as PlannerPeriodAiChecksResponse)
        : null,
    themes:
      isRecord(saved.themes) && Array.isArray(saved.themes.themes)
        ? (saved.themes as unknown as PlannerPeriodAiThemesResponse)
        : null,
    goals,
    weekMarks,
    evidence,
    verdict: verdictKind
      ? {
          kind: verdictKind,
          text: str((saved.verdict as Record<string, unknown>).text, 2_000),
        }
      : null,
    forecast: str(saved.forecast, 2_000),
    previousGrade:
      plannerForecastGrades.find((g) => g === saved.previousGrade) ?? null,
    memo:
      typeof saved.memo === "string"
        ? saved.memo
        : (review.memo?.content ?? null),
    draftMemo: typeof saved.draftMemo === "string" ? saved.draftMemo : null,
    memoBy:
      saved.memoBy === "model" || saved.memoBy === "page"
        ? saved.memoBy
        : review.memo
          ? "page"
          : null,
    memoSaved:
      saved.memoSaved === true ||
      (typeof saved.memo !== "string" && Boolean(review.memo)),
  };
}

/** Thirteen weeks of scores read as numbers: mean, spread and weeks under each floor. */
export function plannerPeriodScoreStats(weeks: readonly PlannerPeriodWeek[]): {
  scored: number;
  auth: { mean: number | null; spread: number | null; below: number };
  ach: { mean: number | null; spread: number | null; below: number };
} {
  const stat = (values: number[], floor: number) => {
    if (values.length === 0) return { mean: null, spread: null, below: 0 };
    const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
    const spread = Math.max(...values) - Math.min(...values);
    return {
      mean: Math.round(mean * 10) / 10,
      spread: Math.round(spread * 10) / 10,
      below: values.filter((v) => v < floor).length,
    };
  };
  const auth = weeks.flatMap((w) => (w.auth === null ? [] : [w.auth]));
  const ach = weeks.flatMap((w) => (w.ach === null ? [] : [w.ach]));
  return {
    scored: weeks.filter((w) => w.auth !== null && w.ach !== null).length,
    auth: stat(auth, plannerScoreFloors.auth),
    ach: stat(ach, plannerScoreFloors.ach),
  };
}

/** The page's own memo when the model has none: the headings with the owner's words under each. */
export function plannerPeriodTemplate(
  review: PlannerPeriodReviewResponse,
  state: PlannerPeriodState,
): string {
  const level: PlannerPeriodLevel = review.level;
  const kind =
    level === "month" ? "Month" : level === "quarter" ? "Quarter" : "Year";
  const steps = plannerPeriodSteps[level];
  const byId = new Map(
    [...review.goals, ...review.child_goals].map((goal) => [goal.id, goal]),
  );
  const goalLines = Object.entries(state.goals)
    .flatMap(([id, entry]) => {
      const goal = byId.get(id);
      if (!goal || (!entry.result && !entry.decision)) return [];
      return [
        `- ${goal.title || "(untitled)"}: ${entry.result ?? "not judged"}${entry.decision ? `, ${entry.decision}` : ""}${entry.note ? ` — ${entry.note}` : ""}`,
      ];
    })
    .join("\n");
  const sections = steps.map((step) => {
    const lines = (state.answers[step.id] ?? []).filter((line) => line.trim());
    const body = lines.length
      ? lines.map((line) => `- ${line}`).join("\n")
      : "(not answered)";
    const extra = step.id === "goals" && goalLines ? `\n${goalLines}` : "";
    return `## ${step.title}\n${body}${extra}`;
  });
  const verdict = state.verdict
    ? `## Verdict\n${state.verdict.kind}${state.verdict.text ? ` — ${state.verdict.text}` : ""}`
    : "## Verdict\n(not chosen)";
  const forecast = `## Forecast\n${state.forecast.trim() || "(not written)"}`;
  return [
    `# ${kind} review: ${review.label}`,
    "",
    ...sections.flatMap((section) => [section, ""]),
    verdict,
    "",
    forecast,
    "",
    `_${level} review · ${review.period_start}_`,
  ].join("\n");
}

/** A goal whose grade sits above its receipts: met with no done task and no note. */
export function plannerGradeAboveReceipts(
  goal: { tasks_linked: number; tasks_done: number },
  entry: PlannerPeriodGoalEntry | undefined,
  receipts: number,
): boolean {
  if (entry?.result !== "met" || entry.note.trim() || receipts > 0) {
    return false;
  }
  return goal.tasks_done === 0;
}
