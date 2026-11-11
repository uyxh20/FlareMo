// Diary to-dos (fork-owned add-on, docs/fork-general-agent.md, "To-dos from
// the diary"). The agent's find_todos tool reads the owner's recent entries
// and lists the lines that read like something still to do, each marked when
// a task on the board already covers it or when it was offered before. Fixed
// word rules, no model: the agent judges which of them are real to-dos and
// proposes those as new-task cards with the entry as their source.

/** At most this many candidate lines in one read. */
export const PLANNER_TODO_LINES_MAX = 60;
/** A candidate line longer than this is cut at a word (the quote stays exact). */
const LINE_MAX = 280;

/**
 * Words that mark a line as something still to do, English and French. Each
 * is matched as whole words, case-insensitively. Past-tense or done forms
 * ("had to", "should have", "[x]") are left out below.
 */
const TODO_MARKERS: readonly RegExp[] = [
  /\bto-?do\b/i,
  /\bto do\s*:/i,
  /\bneeds? to\b/i,
  /\bhave to\b/i,
  /\bhas to\b/i,
  /\bgott?a\b/i,
  /\bgot to\b/i,
  /\bmust\b/i,
  /\bshould\b/i,
  /\bremember to\b/i,
  /\bdon'?t forget\b/i,
  /\bdo not forget\b/i,
  /\bi'?ll\b/i,
  /\bi will\b/i,
  /\bplan(?:ning)? to\b/i,
  /\bgoing to\b/i,
  /\bnext step\b/i,
  /\bfollow up\b/i,
  /\bil faut\b/i,
  /\bfaut que\b/i,
  /\bje dois\b/i,
  /\bà faire\b/i,
  /\bpenser à\b/i,
  /\bne pas oublier\b/i,
];

/** Forms that look like a marker but tell of something done or only wished. */
const NOT_TODO: readonly RegExp[] = [
  /\bshould(?:n'?t)? have\b/i,
  /\bmust have\b/i,
  /\bwould have\b/i,
  /\bhad to\b/i,
  /\bwas going to\b/i,
  /\bwere going to\b/i,
];

const CHECKBOX_OPEN = /^\s*[-*+]\s+\[ \]\s+/;
const CHECKBOX_DONE = /^\s*[-*+]\s+\[[xX]\]\s+/;
const TAGS_ONLY = /^(\s*#[^\s#]+)+\s*$/;

export type PlannerTodoLine = {
  /** The owner's words, exactly as the entry holds them (one line or sentence). */
  quote: string;
  /** True for a Markdown checkbox "- [ ]", the surest sign. */
  checkbox: boolean;
};

/** Splits a paragraph into sentences, keeping each sentence's own words. */
function sentences(line: string): string[] {
  const parts = line.match(/[^.!?]+[.!?]*/g) ?? [line];
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** A candidate's words, cut at a word when the line runs long. */
function cut(text: string): string {
  if (text.length <= LINE_MAX) return text;
  const head = text.slice(0, LINE_MAX);
  const space = head.lastIndexOf(" ");
  return space > 40 ? head.slice(0, space) : head;
}

/**
 * The lines of one entry that read like a to-do: an open checkbox, or a
 * sentence with a marker word. Each quote is the entry's own words (a
 * checkbox loses only its "- [ ] "), so the agent can pass it back as the
 * source quote and the server finds it word for word.
 */
export function plannerDiaryTodoLines(content: string): PlannerTodoLine[] {
  const found: PlannerTodoLine[] = [];
  const seen = new Set<string>();
  const add = (quote: string, checkbox: boolean) => {
    const clean = cut(quote.trim());
    if (clean.length < 3 || seen.has(clean)) return;
    seen.add(clean);
    found.push({ quote: clean, checkbox });
  };
  for (const raw of content.split("\n")) {
    if (!raw.trim() || TAGS_ONLY.test(raw) || CHECKBOX_DONE.test(raw)) continue;
    if (CHECKBOX_OPEN.test(raw)) {
      add(raw.replace(CHECKBOX_OPEN, ""), true);
      continue;
    }
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
    for (const sentence of sentences(line)) {
      if (NOT_TODO.some((rule) => rule.test(sentence))) continue;
      if (TODO_MARKERS.some((rule) => rule.test(sentence))) {
        add(sentence, false);
      }
    }
  }
  return found;
}

/** Words that say nothing about which task a line is (in either language). */
const STOP = new Set(
  (
    "a an the to do of and or for in on at by with my me i im i'm it is be " +
    "need needs have has gotta got must should will ill i'll going plan " +
    "remember dont don't forget todo to-do tomorrow today this that next week " +
    "some up get go also just still really then again maybe " +
    "le la les un une de des du et ou pour en au aux à je il faut que dois " +
    "faire penser ne pas oublier demain"
  ).split(" "),
);

/** A line's content words, lower-cased, for comparing it with task titles. */
export function plannerTodoWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/#[^\s#]+/g, " ")
    .split(/[^a-z0-9']+/)
    .map((word) => word.replace(/^'+|'+$/g, ""))
    .filter((word) => word.length > 1 && !STOP.has(word));
  return new Set(words);
}

/**
 * The task title that already covers a to-do line, or null: every content
 * word of the shorter side (two or more) found in the other, or at least half of the
 * line's words in the title with two or more shared. Loose on purpose; the
 * agent reads both and judges.
 */
export function plannerTodoMatch<T extends { title: string }>(
  quote: string,
  tasks: readonly T[],
): T | null {
  const line = plannerTodoWords(quote);
  if (line.size === 0) return null;
  let best: { task: T; score: number } | null = null;
  for (const task of tasks) {
    const title = plannerTodoWords(task.title);
    if (title.size === 0) continue;
    let shared = 0;
    for (const word of title) if (line.has(word)) shared += 1;
    if (shared === 0) continue;
    const smaller = Math.min(title.size, line.size);
    // One shared word is a match only when both sides are that one word.
    const covers =
      shared === smaller && (smaller >= 2 || title.size === line.size);
    const half = shared >= 2 && shared / line.size >= 0.5;
    if (!covers && !half) continue;
    const score = shared / Math.max(title.size, line.size);
    if (!best || score > best.score) best = { task, score };
  }
  return best?.task ?? null;
}

/** The key two proposals from the same entry and words share. */
export function plannerTodoSourceKey(entryId: string, quote: string): string {
  return `${entryId}|${quote.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/** Text as the source check compares it: case, punctuation and spacing ignored. */
function flatten(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\[[ xX]\]/g, " ")
    .replace(/[.,;:!?"'()[\]*_`~#>+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a to-do's words are in the entry, word for word (case, punctuation
 * and spacing aside). Unlike a review receipt a to-do may be short ("call
 * mum"), so three characters are enough: the entry is named, not searched for.
 */
export function plannerTodoQuoteIn(quote: string, content: string): boolean {
  const needle = flatten(quote);
  return needle.length >= 3 && flatten(content).includes(needle);
}

/** Whether an action is a to-do the agent found in a diary entry. */
export function plannerAgentFromDiary(
  change: Record<string, unknown>,
): boolean {
  const source = change.source;
  return (
    typeof source === "object" &&
    source !== null &&
    typeof (source as Record<string, unknown>).entry_id === "string"
  );
}
