import {
  PLANNER_STALE_BACKLOG_WEEKS,
  PLANNER_STUCK_DOING_DAYS,
  type PlannerAskStartersResponse,
  plannerAddDays,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import { type PlannerBoardCard, plannerReadBoard } from "./board";
import { plannerTodoWords } from "./diary-todos";

// Ask my diary's starters (fork-owned add-on, docs/fork-general-agent.md,
// "The starter buttons"). Replan my week and Tidy my backlog work from lists
// the app counts without a model, so each button can show its count and hide
// when there is nothing to do; the agent's tools read the same lists. Mark
// what I already did and What did my health log miss read the diary, and get
// line finders by fixed word rules, like find_todos.

export type PlannerAttentionCard = PlannerBoardCard & {
  column: "backlog" | "todo" | "doing";
  /** Whole days since the card was last touched (its updated_at). */
  idle_days: number;
};

const DAY_MS = 86_400_000;

function idleDays(card: PlannerBoardCard, today: string): number {
  const touched = Date.parse(card.updated_at);
  const now = Date.parse(`${today}T12:00:00.000Z`);
  return Number.isFinite(touched)
    ? Math.max(0, Math.floor((now - touched) / DAY_MS))
    : 0;
}

/**
 * The cards the counting starters are about: open tasks past their due day
 * (overdue), Doing cards untouched for a week (stuck, not also overdue), and
 * Backlog cards untouched for some weeks (stale, oldest first).
 */
export async function plannerAskAttention(
  db: FlareMoDb,
  input: { userId: string; today: string; staleWeeks?: number },
): Promise<{
  overdue: PlannerAttentionCard[];
  stuck: PlannerAttentionCard[];
  stale: PlannerAttentionCard[];
}> {
  const { today } = input;
  const board = await plannerReadBoard(db, {
    userId: input.userId,
    today,
    doneDays: 0,
  });
  const open: PlannerAttentionCard[] = (
    ["backlog", "todo", "doing"] as const
  ).flatMap((column) =>
    board.columns[column].map((card) => ({
      ...card,
      column,
      idle_days: idleDays(card, today),
    })),
  );
  const overdue = open.filter(
    (card) => card.due_at !== null && card.due_at.slice(0, 10) < today,
  );
  const late = new Set(overdue.map((card) => card.id));
  const stuck = open.filter(
    (card) =>
      card.column === "doing" &&
      !late.has(card.id) &&
      card.idle_days >= PLANNER_STUCK_DOING_DAYS,
  );
  const staleDays = (input.staleWeeks ?? PLANNER_STALE_BACKLOG_WEEKS) * 7;
  const stale = open
    .filter(
      (card) =>
        card.column === "backlog" &&
        !late.has(card.id) &&
        card.idle_days >= staleDays,
    )
    .sort((a, b) => b.idle_days - a.idle_days);
  return { overdue, stuck, stale };
}

/** The counts the starter buttons show. */
export async function plannerAskStarterCounts(
  db: FlareMoDb,
  input: { userId: string; today: string },
): Promise<PlannerAskStartersResponse> {
  const { overdue, stuck, stale } = await plannerAskAttention(db, input);
  return {
    overdue: overdue.length,
    stuck: stuck.length,
    stale_backlog: stale.length,
  };
}

/** Splits an entry into its sentences, keeping each one's own words. */
export function plannerEntrySentences(content: string): string[] {
  return content
    .split("\n")
    .map((line) =>
      line.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, ""),
    )
    .flatMap((line) => line.match(/[^.!?]+[.!?]*/g) ?? [])
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 3);
}

/** Words that tell of something finished, English and French. */
const DONE =
  /\b(?:done|did|finished|finally|completed|sent|submitted|booked|paid|called|rang|emailed|fixed|renewed|bought|returned|signed|cancelled|canceled|delivered|shipped|wrote|cleaned|sorted|handed in|got back|went|met|bought|ordered|posted|replied|answered|applied|registered|uploaded|published|sold|moved|picked up|dropped off|tidied|repaired|replaced|returned|visited|fait|fini|terminé|envoyé|payé|réservé|appelé|acheté)\b/i;
/** ...unless the same sentence says it is still to come. */
const NOT_DONE =
  /\b(?:need to|have to|must|should|will|going to|gonna|tomorrow|not yet|still|didn't|did not|haven't|have not|forgot|todo|to do|il faut|je dois)\b/i;

/** Whether a sentence reads like something finished (fixed word rules). */
export function plannerSoundsDone(sentence: string): boolean {
  return DONE.test(sentence) && !NOT_DONE.test(sentence);
}

/** A sentence that mentions training, breathwork or a night out. */
const HEALTH =
  /(?:#(?:gym|fitness|crossfit|wimhof|wh|meditat\w*|out)\b|\b(?:gym|crossfit|cross fit|workout|trained|training|lifted|deadlifts?|bench|squats?|run|ran|running|jog|swim|swam|cycling|bike ride|yoga|wim ?-?hof|breathwork|breath work|breathing|meditat\w*|went out|night out|drinks|bar|pub|club|party|got home|came home|home at|hangover|hungover)\b)/i;

/** Whether a sentence mentions something the health tracker logs. */
export function plannerMentionsHealth(sentence: string): boolean {
  return HEALTH.test(sentence);
}

const BREATH =
  /(?:#(?:wimhof|wh|meditat\w*)\b|\b(?:wim ?-?hof|breathwork|breath work|breathing|meditat\w*)\b)/i;
const NIGHT =
  /(?:#out\b|\b(?:went out|night out|drinks|bar|pub|club|party|got home|came home|home at|hangover|hungover)\b)/i;

const CARDIO =
  /\b(?:run|ran|running|jog|jogged|jogging|swim|swam|swimming|cycling|cycled|bike ride|zone ?2|cardio)\b/i;

/** The training variant a line names, when it names a cardio session. */
export function plannerTrainingVariantOf(sentence: string): string | null {
  return CARDIO.test(sentence) ? "cardio" : null;
}

/** Which health kind a mention line is about, by fixed word rules. */
export function plannerHealthKindOf(
  sentence: string,
): "training" | "breath" | "night_out" {
  if (BREATH.test(sentence)) return "breath";
  if (
    NIGHT.test(sentence) &&
    !/\b(?:gym|fitness|run|ran|workout|training)\b/i.test(sentence)
  ) {
    return "night_out";
  }
  return "training";
}

/** The day `days` days before today, inclusive span start. */
export function plannerSpanStart(today: string, days: number): string {
  return plannerAddDays(today, -(days - 1));
}

/** Past forms a diary uses for a task's verb: "sent" meets "send". */
const IRREGULAR: Record<string, string> = {
  sent: "send",
  paid: "pay",
  bought: "buy",
  wrote: "write",
  written: "write",
  rang: "call",
  met: "meet",
  did: "do",
  done: "do",
  took: "take",
  taken: "take",
  made: "make",
  got: "get",
  went: "go",
  gave: "give",
  given: "give",
  sold: "sell",
  told: "tell",
  found: "find",
  spoke: "speak",
  ran: "run",
  built: "build",
  left: "leave",
  brought: "bring",
  kept: "keep",
  chose: "choose",
  drove: "drive",
  fed: "feed",
  hung: "hang",
  lent: "lend",
  sought: "seek",
  taught: "teach",
  thought: "think",
  caught: "catch",
  understood: "understand",
};

/** A word's rough stem, so "called" meets "call" and "invoices" meets "invoice". */
function stem(word: string): string {
  const base = IRREGULAR[word] ?? word;
  if (/[^aeiou]ie[sd]$/.test(base)) return `${base.slice(0, -3)}y`;
  return base.replace(/(?:ing|ed|es|s|e)$/, "") || base;
}

/**
 * Whether a sentence is about a task: half or more of the title's content
 * words (and two when the title has two or more) are in it, by rough stem. Measured
 * against the title, not the sentence, since a diary line says much more.
 */
export function plannerSentenceAboutTask(
  sentence: string,
  title: string,
): boolean {
  const titleWords = [...plannerTodoWords(title)].map(stem);
  if (titleWords.length === 0) return false;
  const said = new Set([...plannerTodoWords(sentence)].map(stem));
  const shared = titleWords.filter((word) => said.has(word)).length;
  return (
    shared >= Math.min(2, titleWords.length) &&
    shared / titleWords.length >= 0.5
  );
}
