import {
  type PlannerBoardCard,
  type PlannerBoardResponse,
  type PlannerCreateTaskInput,
  type PlannerGoalDto,
  type PlannerPillar,
  plannerIsoWeekOf,
} from "@flaremo/contracts";

// What the morning page draws from the cockpit's board (fork-owned add-on,
// docs/fork-customizations.md "Morning page"): the open tasks due today or
// overdue, and the week's goals (shown by name only since 11 Nov).
// Pure functions, so the page and its tests read the same rules.

/** At most this many tasks in "Due today" (three shown at a time). */
export const plannerMorningDueMax = 30;
/** Tasks shown at once; more than this brings the up and down arrows. */
export const plannerMorningDueVisible = 3;

export type PlannerMorningTask = {
  id: string;
  title: string;
  /** Days past the due date; 0 when due today. */
  daysLate: number;
  done: boolean;
};

export type PlannerMorningGoal = {
  id: string;
  title: string;
  pillar: PlannerPillar | null;
  done: number;
  total: number;
};

function allCards(board: PlannerBoardResponse): PlannerBoardCard[] {
  const { backlog, todo, doing, done, other } = board.columns;
  return [...backlog, ...todo, ...doing, ...done, ...other];
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) /
      86_400_000,
  );
}

/**
 * Open tasks due today or earlier, oldest due first, at most thirty. A task the
 * owner ticked on this page (`ticked`) stays in the list, shown done, so a
 * tick never makes a row jump away.
 */
export function plannerMorningDue(
  board: PlannerBoardResponse,
  today: string,
  ticked: ReadonlySet<string> = new Set(),
): PlannerMorningTask[] {
  return allCards(board)
    .filter((card) => {
      if (!card.due_at || card.dropped_at !== null) return false;
      if (card.due_at.slice(0, 10) > today) return false;
      return card.status !== "done" || ticked.has(card.id);
    })
    .sort(
      (left, right) =>
        (left.due_at ?? "").localeCompare(right.due_at ?? "") ||
        left.title.localeCompare(right.title),
    )
    .slice(0, plannerMorningDueMax)
    .map((card) => ({
      id: card.id,
      title: card.title,
      daysLate: Math.max(
        0,
        daysBetween((card.due_at ?? today).slice(0, 10), today),
      ),
      done: card.status === "done",
    }));
}

/** The week's goals, each with how many of its tasks are done. */
export function plannerMorningGoals(
  board: PlannerBoardResponse,
): PlannerMorningGoal[] {
  const goals: PlannerGoalDto[] = board.week?.goals ?? [];
  const cards = allCards(board);
  return goals.map((goal) => {
    const own = cards.filter(
      (card) => card.goal_id === goal.id && card.dropped_at === null,
    );
    const done = own.filter((card) => card.status === "done").length;
    const total = own.length;
    return {
      id: goal.id,
      title: goal.title,
      pillar: goal.pillar ?? null,
      done,
      total,
    };
  });
}

/** "Week 46 goals" for the board's goal week; "This week's goals" without one. */
export function plannerMorningGoalsHeading(
  board: PlannerBoardResponse,
): string {
  const start = board.week?.start;
  return start
    ? `Week ${plannerIsoWeekOf(start).week} goals`
    : "This week's goals";
}

/** "Tuesday, 10 Nov" for a `YYYY-MM-DD` day. */
export function plannerMorningDateLabel(today: string): string {
  const date = new Date(`${today}T12:00:00Z`);
  const weekday = date.toLocaleDateString("en-GB", {
    weekday: "long",
    timeZone: "UTC",
  });
  const dayMonth = date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return `${weekday}, ${dayMonth}`;
}

/** "2d late" for an overdue task, nothing when it is due today. */
export function plannerMorningLateLabel(daysLate: number): string | null {
  return daysLate > 0 ? `${daysLate}d late` : null;
}

/**
 * Which slice of "Due today" is on screen: pages of three (1-3, 4-6, 7),
 * clamped so a list that shrinks never shows an empty page, and where the up
 * and down arrows go.
 */
export function plannerMorningDueWindow(
  total: number,
  start: number,
  size: number = plannerMorningDueVisible,
): {
  from: number;
  to: number;
  paged: boolean;
  canUp: boolean;
  canDown: boolean;
  upStart: number;
  downStart: number;
} {
  const lastPage = Math.max(0, Math.floor((total - 1) / size)) * size;
  const page = Math.floor(Math.max(0, start) / size) * size;
  const from = Math.min(page, lastPage);
  const to = Math.min(total, from + size);
  return {
    from,
    to,
    paged: total > size,
    canUp: from > 0,
    canDown: to < total,
    upStart: Math.max(0, from - size),
    downStart: Math.min(lastPage, from + size),
  };
}

/** The note on a task made from the idea line, so the cockpit shows where it came from. */
export const plannerMorningIdeaTaskNote = "From the morning page's idea line.";

/** The "+" request: the idea as a task in To Do, planned for today and due today. */
export function plannerMorningIdeaTaskInput(
  text: string,
  today: string,
): PlannerCreateTaskInput {
  return {
    title: text,
    notes: plannerMorningIdeaTaskNote,
    column: "todo",
    plan: { horizon: "day", day: today },
    due_at: today,
    today,
  };
}

/**
 * Whether the idea is already a task due today (same words, not dropped), so
 * "+" shows a tick after a reload and never adds it twice.
 */
export function plannerMorningLineIsTask(
  board: PlannerBoardResponse | undefined,
  text: string,
  today: string,
): boolean {
  if (!board) return false;
  return allCards(board).some(
    (card) =>
      card.title.trim() === text.trim() &&
      card.dropped_at === null &&
      (card.due_at ?? "").slice(0, 10) === today,
  );
}
