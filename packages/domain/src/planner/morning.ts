import {
  healthLocalDayStart,
  healthLocalMoment,
  type PlannerMorningDirection,
  type PlannerMorningLine,
  plannerAddDays,
  plannerMorningDirectionFor,
  plannerPeriodMemoSource,
  plannerSummaryMemoSource,
  plannerSummaryMemoTag,
  plannerWeekStartOf,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { memos, memoTags, tasks } from "@flaremo/db";
import {
  plannerMorningDay,
  plannerMorningLine,
  plannerTaskPlan,
} from "@flaremo/db/src/schema/planner";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { healthReadWeek } from "../health/read";
import { plannerReadWeekGoals } from "./goals";
import { plannerRequireDay } from "./shared";

// The morning page (fork-owned add-on, docs/fork-customizations.md, "Morning
// page"): the idea line at the top of the page the diary opens on each
// morning, and whether the page was dismissed for the day.
//
// The prompt is the one Anon picked in the tuning rounds of 10 Nov 2026
// (round 2, /mnt/project-files/morning-card/sim/round2.mjs): the system text
// below word for word, one of two directions that alternate by day, and a
// context of this week's goals, tasks due, the health week, three weeks of
// entries and the last seven lines. Don't add the round 3 "what this reader
// likes" list: it made lines narrower.
//
// Every line is kept with the tokens it cost and whether it was shown, kept
// ("Start the day") or replaced ("Another"): flywheel data.

/** Claude Opus 5.5 at medium effort, about $0.02 a line. */
export const plannerMorningModel = "claude-opus-5-5";

export const plannerMorningSystemPrompt = `You write the one line at the top of a personal diary app's morning card. The owner reads it with their first coffee.

What a good line is:
- One concrete, small thing they could actually do today, that would make the day a bit more interesting, connected or alive.
- It grows out of THEIR life: the people, places, interests, half-finished thoughts, running jokes and loose ends in their recent entries. It should feel like it came from a friend who reads their diary, not from a listicle about spontaneity.
- Light, natural wit. A smile, not a punchline. Sounds like a sharp friend texting, never like an ad, a coach or a fortune cookie.
- One line, at most 22 words, plain text. No quotes, no emoji, no hashtags, no "Dare:" prefix.
- Speak to them as "you". Never lecture, never guilt them about tasks, no health or medical advice. Don't quote the diary word for word; don't rewrite their tasks or goals.

Variety (very important):
- Before writing, privately think of at least six very different kinds of idea that fit today, for example: reaching out to a specific person, a creative or making thing, something with their body or outdoors in their own routine, learning or reading something, cooking or their home, a small kindness, a playful twist on something already on their plan, a reflection prompt, an experiment with their routine. Then pick the one that fits this particular day best.
- Do not reuse the kind of idea, the setting, or any phrasing from the recent lines you are shown.
- Banned clichés: buses, trams or ferries to the end of the line; benches; playing tourist; food you can't pronounce; weird fruit or pumpkins; flights or trips; anything "random"; "before your coffee goes cold"; crowning or naming things; pirates or ship launches; "go rogue".
- Don't lean on the same big recent event every day. Most days are ordinary; find what's specific about this one.`;

export const plannerMorningDirectionPrompts: Record<
  PlannerMorningDirection,
  string
> = {
  away: "Direction for this line: something off-plan, unrelated to their goals and tasks, that would still clearly be good for them today.",
  free: "Direction for this line: your call. Toward a goal or off-plan, whichever would land best today.",
};

/** Days of entries the line reads, and how many of them are read in full. */
const ENTRY_DAYS = 21;
const RECENT_DAYS = 3;
const OLDER_CHARS = 300;
const RECENT_CHARS = 1_500;
const ENTRY_ROWS_MAX = 400;
const DUE_MAX = 5;
const DUE_LOOKBACK_DAYS = 7;
const RECENT_LINES = 7;

export type PlannerMorningContext = {
  /** "Wednesday 11 Nov" (as the tuning rounds wrote it). */
  weekday: string;
  goals: Array<{ title: string; tasks: number; done: number }>;
  due: Array<{ title: string; due: string }>;
  health: {
    sessions: number;
    target: number;
    breathDays: number;
    nights: number;
  } | null;
  entries: Array<{ day: string; time: string; recent: boolean; text: string }>;
};

/** "Wednesday 11 Nov" for a `YYYY-MM-DD` day. */
export function plannerMorningWeekday(today: string): string {
  return new Date(`${today}T12:00:00Z`).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** The user turn: the same layout as the tuning rounds. */
export function plannerMorningContextText(
  context: PlannerMorningContext,
  recentLines: readonly string[],
): string {
  const lines = [`Today is ${context.weekday}.`];
  lines.push(
    "This week's goals:",
    ...(context.goals.length
      ? context.goals.map(
          (goal) => `- ${goal.title} (${goal.done}/${goal.tasks} tasks done)`,
        )
      : ["- none set"]),
  );
  lines.push(
    "Due today or overdue:",
    ...(context.due.length
      ? context.due.map((task) => `- ${task.title} (due ${task.due})`)
      : ["- nothing"]),
  );
  if (context.health) {
    const health = context.health;
    lines.push(
      `This week so far: ${health.sessions}/${health.target} training sessions, ${health.breathDays} breathwork days, ${health.nights} nights out.`,
    );
  }
  lines.push(
    "Older entries (3 weeks, shortened, for a sense of their life):",
    ...context.entries
      .filter((entry) => !entry.recent)
      .map((entry) => `[${entry.day}] ${entry.text.replace(/\s+/g, " ")}`),
  );
  lines.push(
    "Last 3 days (full):",
    ...context.entries
      .filter((entry) => entry.recent)
      .map((entry) => `[${entry.day} ${entry.time}] ${entry.text}`),
  );
  lines.push(
    "Your lines from the previous days (do not repeat their idea, setting or phrasing):",
    ...(recentLines.length
      ? recentLines.map((line) => `- ${line}`)
      : ["- none yet"]),
  );
  return `${lines.join("\n")}\n\nWrite today's line. Reply with the line only.`;
}

/** System and user text for one line. */
export function plannerMorningMessages(
  direction: PlannerMorningDirection,
  context: PlannerMorningContext,
  recentLines: readonly string[],
): { system: string; user: string } {
  return {
    system: `${plannerMorningSystemPrompt}\n\n${plannerMorningDirectionPrompts[direction]}`,
    user: plannerMorningContextText(context, recentLines),
  };
}

/**
 * The model's answer as one clean line: the first non-empty line, without
 * wrapping quotes. Empty when there is nothing usable (the slot then hides).
 */
export function plannerCleanMorningLine(answer: string): string {
  const first =
    answer
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  return first
    .replace(/^["“'‘]+/, "")
    .replace(/["”'’]+$/, "")
    .trim()
    .slice(0, 400);
}

const LIVE_MEMO = and(
  isNull(memos.deletedAt),
  inArray(memos.status, ["normal", "archived"]),
);

/** Everything the line reads, for the owner's `today`. Reads only. */
export async function plannerReadMorningContext(
  db: FlareMoDb,
  input: { userId: string; today: string },
): Promise<PlannerMorningContext> {
  const today = plannerRequireDay(input.today, "today");
  const weekStart = plannerWeekStartOf(today);
  const todayStart = healthLocalDayStart(today);
  const entriesFrom = healthLocalDayStart(plannerAddDays(today, -ENTRY_DAYS));
  const recentFrom = plannerAddDays(today, -RECENT_DAYS);
  const summaries = db
    .select({ id: memoTags.memoId })
    .from(memoTags)
    .where(
      and(
        eq(memoTags.userId, input.userId),
        eq(memoTags.tag, plannerSummaryMemoTag),
      ),
    );

  const [goals, due, health, entries] = await Promise.all([
    plannerReadWeekGoals(db, { userId: input.userId, weekStart }),
    db
      .select({ title: tasks.title, dueAt: tasks.dueAt })
      .from(tasks)
      .leftJoin(plannerTaskPlan, eq(plannerTaskPlan.taskId, tasks.id))
      .where(
        and(
          eq(tasks.userId, input.userId),
          isNull(tasks.deletedAt),
          ne(tasks.status, "done"),
          isNull(plannerTaskPlan.droppedAt),
          isNotNull(tasks.dueAt),
          sql`substr(${tasks.dueAt}, 1, 10) <= ${today}`,
          sql`substr(${tasks.dueAt}, 1, 10) >= ${plannerAddDays(today, -DUE_LOOKBACK_DAYS)}`,
        ),
      )
      .orderBy(asc(tasks.dueAt))
      .limit(DUE_MAX)
      .all(),
    healthReadWeek(db, { userId: input.userId, start: weekStart }).catch(
      () => null,
    ),
    db
      .select({ at: memos.createdAt, content: memos.content })
      .from(memos)
      .where(
        and(
          eq(memos.userId, input.userId),
          LIVE_MEMO,
          gte(memos.createdAt, entriesFrom),
          ne(memos.source, plannerSummaryMemoSource),
          ne(memos.source, plannerPeriodMemoSource),
          notInArray(memos.id, summaries),
        ),
      )
      .orderBy(desc(memos.createdAt))
      .limit(ENTRY_ROWS_MAX)
      .all(),
  ]);

  const goalIds = goals.map((goal) => goal.id);
  const goalTasks = goalIds.length
    ? await db
        .select({
          goalId: plannerTaskPlan.goalId,
          status: tasks.status,
          completedAt: tasks.completedAt,
        })
        .from(plannerTaskPlan)
        .innerJoin(tasks, eq(tasks.id, plannerTaskPlan.taskId))
        .where(
          and(
            eq(plannerTaskPlan.userId, input.userId),
            inArray(plannerTaskPlan.goalId, goalIds),
            isNull(tasks.deletedAt),
            isNull(plannerTaskPlan.droppedAt),
          ),
        )
        .all()
    : [];

  return {
    weekday: plannerMorningWeekday(today),
    goals: goals.map((goal) => {
      const own = goalTasks.filter((task) => task.goalId === goal.id);
      return {
        title: goal.title,
        tasks: own.length,
        // Done before this morning, as the tuning rounds counted it.
        done: own.filter(
          (task) =>
            task.status === "done" &&
            (!task.completedAt || task.completedAt < todayStart),
        ).length,
      };
    }),
    due: due.map((task) => ({
      title: task.title,
      due: (task.dueAt ?? "").slice(0, 10),
    })),
    health: health
      ? {
          sessions: health.summary.training.sessions,
          target: health.summary.training.target,
          breathDays: health.summary.breath.days,
          nights: health.summary.night_out.nights,
        }
      : null,
    entries: entries
      .filter((entry) => !/^# Week \d+/.test(entry.content))
      .reverse()
      .map((entry) => {
        const local = healthLocalMoment(entry.at);
        const recent = local.day >= recentFrom;
        return {
          day: local.day,
          time: `${String(local.hour).padStart(2, "0")}:${String(local.minute).padStart(2, "0")}`,
          recent,
          text: entry.content.slice(0, recent ? RECENT_CHARS : OLDER_CHARS),
        };
      }),
  };
}

/** The texts of the last lines shown before `today` (and earlier today), newest last. */
export async function plannerRecentMorningLines(
  db: FlareMoDb,
  input: { userId: string; today: string },
): Promise<string[]> {
  const rows = await db
    .select({ text: plannerMorningLine.text })
    .from(plannerMorningLine)
    .where(
      and(
        eq(plannerMorningLine.userId, input.userId),
        lte(plannerMorningLine.day, input.today),
      ),
    )
    .orderBy(desc(plannerMorningLine.createdAt))
    .limit(RECENT_LINES)
    .all();
  return rows.map((row) => row.text).reverse();
}

function toLine(row: {
  id: string;
  text: string;
  direction: PlannerMorningDirection;
}): PlannerMorningLine {
  return { id: row.id, text: row.text, direction: row.direction };
}

/** The day's line (its newest one not replaced), or null. */
export async function plannerReadMorningLine(
  db: FlareMoDb,
  input: { userId: string; today: string },
): Promise<PlannerMorningLine | null> {
  const row = await db
    .select()
    .from(plannerMorningLine)
    .where(
      and(
        eq(plannerMorningLine.userId, input.userId),
        eq(plannerMorningLine.day, input.today),
        isNull(plannerMorningLine.replacedBy),
      ),
    )
    .orderBy(desc(plannerMorningLine.createdAt))
    .limit(1)
    .get();
  return row ? toLine(row) : null;
}

/** Whether "Start the day" was pressed for `today`. */
export async function plannerReadMorningDismissed(
  db: FlareMoDb,
  input: { userId: string; today: string },
): Promise<boolean> {
  const row = await db
    .select({ dismissedAt: plannerMorningDay.dismissedAt })
    .from(plannerMorningDay)
    .where(
      and(
        eq(plannerMorningDay.userId, input.userId),
        eq(plannerMorningDay.day, input.today),
      ),
    )
    .get();
  return Boolean(row?.dismissedAt);
}

/**
 * Saves a new line for `today`, marked shown, and points the day's line it
 * replaces ("Another") at it.
 */
export async function plannerSaveMorningLine(
  db: FlareMoDb,
  input: {
    userId: string;
    today: string;
    text: string;
    direction: PlannerMorningDirection;
    model: string;
    inputTokens: number;
    outputTokens: number;
    now?: Date;
  },
): Promise<PlannerMorningLine> {
  const id = crypto.randomUUID();
  const at = (input.now ?? new Date()).toISOString();
  const insert = db.insert(plannerMorningLine).values({
    id,
    userId: input.userId,
    day: input.today,
    text: input.text,
    direction: input.direction,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    shown: 1,
    chosen: 0,
    replacedBy: null,
    createdAt: at,
  });
  // Every line of the day still on screen is replaced, so only the new one is.
  const replaceOld = db
    .update(plannerMorningLine)
    .set({ replacedBy: id })
    .where(
      and(
        eq(plannerMorningLine.userId, input.userId),
        eq(plannerMorningLine.day, input.today),
        isNull(plannerMorningLine.replacedBy),
      ),
    );
  await db.batch([replaceOld, insert]);
  return { id, text: input.text, direction: input.direction };
}

/** "Start the day": the day is dismissed and the line on screen is the one kept. */
export async function plannerDismissMorning(
  db: FlareMoDb,
  input: {
    userId: string;
    today: string;
    lineId?: string | null;
    now?: Date;
  },
): Promise<void> {
  const at = (input.now ?? new Date()).toISOString();
  const day = db
    .insert(plannerMorningDay)
    .values({
      userId: input.userId,
      day: input.today,
      dismissedAt: at,
      createdAt: at,
    })
    .onConflictDoUpdate({
      target: [plannerMorningDay.userId, plannerMorningDay.day],
      set: { dismissedAt: at },
    });
  if (!input.lineId) {
    await day;
    return;
  }
  await db.batch([
    day,
    db
      .update(plannerMorningLine)
      .set({ chosen: 1 })
      .where(
        and(
          eq(plannerMorningLine.userId, input.userId),
          eq(plannerMorningLine.id, input.lineId),
        ),
      ),
  ]);
}
