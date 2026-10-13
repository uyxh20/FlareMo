import {
  type HealthBreathVariant,
  type HealthKind,
  type HealthTrainingVariant,
  healthAddDays,
  healthDefaultBreathMinutes,
  healthLocalMoment,
  healthLongMemoChars,
  healthMaxMemoChars,
  healthNightUnitsFor,
  healthSkipSources,
  healthSkipTags,
  healthWeekdayOf,
  healthWeekStartOf,
} from "@flaremo/contracts";

// The health tracker's diary reader (fork-owned add-on, docs/fork-health-tracker.md).
//
// A pure, deterministic function from one memo's text and creation time to the
// training sessions, breath sessions and nights out it states. No AI, no clock,
// no database: the same input always gives the same rows, which is what lets the
// sync re-read a memo and diff the result. The rules are written out in
// docs/fork-health-tracker.md; the table test in parse.test.ts is their spec.
//
// Reading order: skip what is never read (tags, source, length), strip an
// imported timestamp prefix, normalise, split into sentences, find each kind's
// keywords per sentence, reject plans and negations, resolve the day, and read a
// night's home time. A memo yields at most one entry per kind.

export type HealthParseInput = {
  content: string;
  /** The memo's `created_at` (UTC ISO). It stays the source of truth for the day. */
  createdAt: string;
  /** The memo's tags, without `#`. Hashtags in the text are checked as well. */
  tags?: readonly string[];
  /** The memo's `source` column. */
  source?: string | null;
};

export type HealthParsedEntry = {
  kind: HealthKind;
  /** The local day, `YYYY-MM-DD`. */
  day: string;
  variant: HealthTrainingVariant | HealthBreathVariant | null;
  minutes: number | null;
  /** `HH:MM`, night_out only. */
  homeAt: string | null;
  units: number | null;
  bender: boolean;
  needsCheck: boolean;
  feel: string | null;
};

// --- Skips and normalisation ------------------------------------------------

/** `**2026-09-19 08:23:** text`, the prefix the import wrote. */
const TIMESTAMP_PREFIX =
  /^\s*\*\*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?:?\*\*\s*/;

/** The text without an imported `**YYYY-MM-DD HH:MM:**` prefix. */
export function healthStripTimestampPrefix(content: string): string {
  return content.replace(TIMESTAMP_PREFIX, "");
}

const SKIP_TAGS: ReadonlySet<string> = new Set(healthSkipTags);
const SKIP_SOURCES: ReadonlySet<string> = new Set(healthSkipSources);
const SKIP_HASHTAG = new RegExp(
  `(?:^|[^\\w])#(?:${healthSkipTags.join("|")})(?![\\w-])`,
  "i",
);

function tagIsSkipped(tag: string): boolean {
  const clean = tag.replace(/^#/, "").toLowerCase();
  return SKIP_TAGS.has(clean) || SKIP_TAGS.has(clean.split("/")[0] ?? "");
}

/**
 * Whether a memo is never read: a summary, theme, tracker, seed or agent-memory
 * tag, the weekly review's own memo, or a text too long to be a log line.
 */
export function healthMemoIsSkipped(input: {
  content: string;
  tags?: readonly string[];
  source?: string | null;
}): boolean {
  if (input.content.length > healthMaxMemoChars) return true;
  if (input.source && SKIP_SOURCES.has(input.source)) return true;
  if (input.tags?.some(tagIsSkipped)) return true;
  return SKIP_HASHTAG.test(input.content);
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/['](?=til\b)/g, "")
    .replace(/[→⇒➔]/g, "->")
    .replace(/(\d)\.(\d{2})\b/g, "$1:$2")
    .replace(/[ \t ]+/g, " ");
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

// --- Shared vocabulary --------------------------------------------------------

/** Words that say something was done, in the past. */
const DONE =
  /\b(?:done|did|finished|completed|smashed|crushed|nailed|trained|meditated|went (?:to|out)|got home|came home)\b/;

/** A plan, a wish or a maybe. Without a done word it is not an event. */
const PLAN =
  /\b(?:going to|gonna|will|won't|plan(?:s|ned|ning)?|should|shall|need(?:s)? to|want(?:s)? to|wanna|have to|has to|got to|gotta|tomorrow|tmrw|tmr|later today|later on|later tonight|next week|next weekend|maybe|might|could|if i|hopefully|todo|to do|to-do|try to|trying to|aim(?:ing)? to|let's|lets|supposed to|thinking (?:of|about)|booked|booking|scheduled|reminder|remind me)\b|\b(?:this (?:morning|afternoon|evening)|today) (?:it's|its|is|i'm|im|i will)\b|\bit's (?:gym|crossfit)\b|\btonight\b/;

/** `tonight` is a plan for a session but a day word for a night out. */
const PLAN_FOR_NIGHT = new RegExp(PLAN.source.replace("|\\btonight\\b", ""));

/** A negation just before a keyword (`no gym`, `didn't do crossfit`). */
const NEGATED_BEFORE =
  /\b(?:no|not|without|skipped|skip|skipping|missed|miss|never|didn't|didnt|did not|haven't|havent|hadn't|wasn't|wasnt|couldn't|can't|cant|zero|nothing|none|cancelled|canceled|cancel)\b(?:\s+[\w#-]+){0,2}\s*$/;

/** A negation just after a keyword (`gym skipped`, `crossfit cancelled`). */
const NEGATED_AFTER =
  /^\s*[:\-]?\s*(?:was |is |got )?(?:skipped|cancelled|canceled|missed|not\b|no\b|didn't|didnt|nope|off\b)/;

function negatedAt(text: string, index: number, length: number): boolean {
  const before = text.slice(Math.max(0, index - 40), index);
  const after = text.slice(index + length, index + length + 24);
  return NEGATED_BEFORE.test(before) || NEGATED_AFTER.test(after);
}

const WEEKDAYS = [
  "mon(?:day)?",
  "tue(?:s|sday)?",
  "wed(?:nesday)?",
  "thu(?:rs?|rsday)?",
  "fri(?:day)?",
  "sat(?:urday)?",
  "sun(?:day)?",
] as const;
const WEEKDAY = new RegExp(`\\b(${WEEKDAYS.join("|")})\\b`, "g");

function weekdayIndex(word: string): number {
  return WEEKDAYS.findIndex((pattern) => new RegExp(`^${pattern}$`).test(word));
}

const LAST_WEEK = /\b(?:last week|previous week|last weekend)\b/;
const RETRO =
  /\b(?:forgot to (?:log|write|add|record|put)|forgot to log|late entry|logging late|logging this late|didn't log|didnt log|belated)\b/;

/** An hour of an evening's end: 17:00 and later is before midnight. */
function nightOrder(homeAt: string): number {
  const hour = Number(homeAt.slice(0, 2));
  return (hour < 17 ? hour + 24 : hour) * 60 + Number(homeAt.slice(3, 5));
}

// --- Day resolution -------------------------------------------------------------

/**
 * The most recent `weekday` (0 = Monday) on or before `entryDay`. With "last
 * week" the answer is never in the entry's own calendar week: a Wednesday entry
 * saying "last week wed" means seven days ago.
 */
function resolveWeekday(
  entryDay: string,
  weekday: number,
  lastWeek: boolean,
): string {
  const back = (healthWeekdayOf(entryDay) - weekday + 7) % 7;
  let day = healthAddDays(entryDay, -back);
  if (lastWeek && healthWeekStartOf(day) === healthWeekStartOf(entryDay)) {
    day = healthAddDays(day, -7);
  }
  return day;
}

type NamedWeekday = { index: number; endMarked: boolean };

/** Weekday words of a text, each flagged when it names where a night ended. */
function namedWeekdays(text: string): NamedWeekday[] {
  const found: NamedWeekday[] = [];
  for (const match of text.matchAll(WEEKDAY)) {
    const before = text.slice(Math.max(0, match.index - 14), match.index);
    found.push({
      index: weekdayIndex(match[1] ?? ""),
      endMarked: /(?:\b(?:til|till|until|into|to|thru|through|by)|->)\s*$/.test(
        before,
      ),
    });
  }
  return found.filter((day) => day.index >= 0);
}

// --- Training -------------------------------------------------------------------

const SPLIT_NAMES: Record<string, HealthTrainingVariant> = {
  push: "push",
  pull: "pull",
  back: "back",
  chest: "chest",
  leg: "legs",
  legs: "legs",
  upper: "upper",
};

const SPLIT_DAY =
  /\b(push|pull|back|chest|legs?|upper)(?: body)? (?:day|session|workout)\b/;
const SPLIT_NEAR_GYM =
  /(?:#?\bgym|#gym)[ :,-]+(push|pull|back|chest|legs?|upper)\b|\b(push|pull|back|chest|legs?|upper)[ :,-]+#?gym\b/;
const CROSSFIT = /(?:#crossfit|\bcross ?fit)\b/;
const BENCH = /\bbench(?: press)?\b/;
const DEADLIFT = /\bdeadlifts?\b/;
const GYM_TAG = /(?:^|[^\w])#gym(?![\w-])/;
const GYM_WORD = /(?<![#\w])gym\b/g;
const GYM_PLACE_BEFORE =
  /\b(?:outside|before|after|near|beside|behind|inside|around|from|at|in|leaving|left|walking to|walk to|drive to|driving to)(?: (?:the|a|my|our))?\s*$/;
const ZONE2 = /\bzone ?2\b/;
const CARDIO_WORD =
  /\b(?:bike|biking|cycling|run|ran|running|jog|jogging|cardio)\b/g;
const DURATION =
  /\b(\d{1,3}(?:\.\d)?)\s*(min|mins|minutes|km|k|miles|mi|hours?|hrs?|h)\b/;
const SESSION_EVIDENCE = /\b(?:session|workout|day|lifted|reps|sets|pb)\b/;

type TrainingHit = {
  variant: HealthTrainingVariant;
  /** Higher wins when a memo has several. */
  rank: number;
  minutes: number | null;
  explicit: boolean;
};

function durationMinutes(text: string): number | null {
  const match = DURATION.exec(text);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "";
  if (/^(?:km|k|miles|mi)$/.test(unit)) return null;
  const minutes = /^h/.test(unit)
    ? Math.round(amount * 60)
    : Math.round(amount);
  return minutes >= 1 && minutes <= 600 ? minutes : null;
}

function trainingHit(clause: string): TrainingHit | null {
  const crossfit = CROSSFIT.exec(clause);
  if (crossfit && !negatedAt(clause, crossfit.index, crossfit[0].length)) {
    return {
      variant: "crossfit",
      rank: 9,
      minutes: null,
      explicit: clause.includes("#crossfit"),
    };
  }
  const explicit = GYM_TAG.test(clause);
  const split =
    SPLIT_DAY.exec(clause) ??
    (explicit || /\bgym\b/.test(clause) ? SPLIT_NEAR_GYM.exec(clause) : null);
  if (split && !negatedAt(clause, split.index, split[0].length)) {
    const name = split[1] ?? split[2] ?? "";
    const variant = SPLIT_NAMES[name];
    if (variant) return { variant, rank: 8, minutes: null, explicit };
  }
  const bench = BENCH.exec(clause);
  if (
    bench &&
    !negatedAt(clause, bench.index, bench[0].length) &&
    (/bench press/.test(clause) ||
      /\b(?:done|day|session|gym|reps|sets|kg|pb|\d)\b|#gym/.test(clause))
  ) {
    return { variant: "chest", rank: 7, minutes: null, explicit };
  }
  const deadlift = DEADLIFT.exec(clause);
  if (deadlift && !negatedAt(clause, deadlift.index, deadlift[0].length)) {
    return { variant: "gym", rank: 6, minutes: null, explicit };
  }
  const zone = ZONE2.exec(clause);
  if (zone && !negatedAt(clause, zone.index, zone[0].length)) {
    return {
      variant: "cardio",
      rank: 5,
      minutes: durationMinutes(clause),
      explicit,
    };
  }
  for (const word of clause.matchAll(CARDIO_WORD)) {
    if (negatedAt(clause, word.index, word[0].length)) continue;
    // `run` and `bike` are ordinary words: a duration or a done word makes
    // them a session.
    if (DURATION.test(clause) || DONE.test(clause) || word[0] === "cardio") {
      return {
        variant: "cardio",
        rank: 4,
        minutes: durationMinutes(clause),
        explicit,
      };
    }
  }
  if (explicit) {
    const tag = GYM_TAG.exec(clause);
    if (tag && !negatedAt(clause, tag.index, tag[0].length)) {
      return { variant: "gym", rank: 3, minutes: null, explicit: true };
    }
    return null;
  }
  for (const word of clause.matchAll(GYM_WORD)) {
    if (negatedAt(clause, word.index, word[0].length)) continue;
    const place = GYM_PLACE_BEFORE.test(clause.slice(0, word.index));
    const evidence =
      DONE.test(clause) ||
      SESSION_EVIDENCE.test(clause) ||
      wordCount(clause) <= 3;
    // "wim hof outside gym" and "before gym" name a place, not a session.
    if (!place && evidence) {
      return { variant: "gym", rank: 3, minutes: null, explicit: false };
    }
  }
  return null;
}

// --- Breath -------------------------------------------------------------------------

const WIM_HOF = /(?:#wimhof|#wh|\bwim ?-?hof|\bwh)(?![\w-])/g;
const MEDITATION = /(?:#meditat\w*|\bmeditat\w*|\bbreath ?work)(?![\w-])/g;

type BreathHit = {
  variant: HealthBreathVariant;
  minutes: number;
  explicit: boolean;
};

function breathMinutes(clause: string, after: number): number {
  const timed = durationMinutes(clause);
  if (timed !== null) return timed;
  // `wim hof 15`: a bare number right after the keyword.
  const bare = /^\s*[-:]?\s*(\d{1,3})\b(?!\s*(?:x|rounds?|breaths?|%))/.exec(
    clause.slice(after),
  );
  if (bare) {
    const minutes = Number(bare[1]);
    if (minutes >= 1 && minutes <= 180) return minutes;
  }
  return healthDefaultBreathMinutes;
}

function breathHit(clause: string, sentence: string): BreathHit | null {
  const candidates: Array<{
    variant: HealthBreathVariant;
    match: RegExpMatchArray;
  }> = [];
  for (const match of clause.matchAll(WIM_HOF)) {
    candidates.push({ variant: "wim_hof", match });
  }
  for (const match of clause.matchAll(MEDITATION)) {
    candidates.push({ variant: "meditation", match });
  }
  candidates.sort((a, b) => (a.match.index ?? 0) - (b.match.index ?? 0));
  for (const { variant, match } of candidates) {
    const index = match.index ?? 0;
    if (negatedAt(clause, index, match[0].length)) continue;
    const explicit = match[0].startsWith("#");
    const timed =
      durationMinutes(clause) !== null ||
      /^\s*[-:]?\s*\d{1,3}\b/.test(clause.slice(index + match[0].length));
    // A bare mention ("wim hof helps") is not a session: it needs a duration,
    // a done word, a hashtag, or to be the whole short entry.
    if (
      !(explicit || timed || DONE.test(sentence) || wordCount(sentence) <= 4)
    ) {
      continue;
    }
    return {
      variant,
      minutes: breathMinutes(clause, index + match[0].length),
      explicit,
    };
  }
  return null;
}

// --- Feel ------------------------------------------------------------------------------

const FEEL =
  /\b(?:felt|feel|feels|feeling)\s+((?:(?:a|an|so|really|very|quite|pretty|bit|little|kind|of|kinda|sort|super|well|bloody|fucking|like)\s+)*)([a-z]{3,20})\b/;
const FEEL_STOP = new Set([
  "the",
  "that",
  "this",
  "like",
  "for",
  "and",
  "but",
  "was",
  "when",
  "how",
  "what",
  "much",
  "more",
  "less",
]);

function feelWord(text: string): string | null {
  const match = FEEL.exec(text);
  const word = match?.[2];
  return word && !FEEL_STOP.has(word) ? word : null;
}

// --- Night out ---------------------------------------------------------------------------

const NIGHT_STRONG =
  /(?:^|[^\w])#out(?![\w-])|\bnights? out\b|\bwent out\b|\bout drinking\b|\bbar night\b|\bbender\b|\bclubbing\b|\bpartied\b|\bpartying\b|\bout out\b/;
const NIGHT_WEAK = /\b(?:club|rave|party|festival)\b/;
const NIGHT_NOT =
  /\b(?:book|fight|golf|football|soccer|tennis|chess|running|yacht|sports|country|youth|glee)\s+club\b|\bclub\s+(?:sandwich|mate|soda|med)\b|\brave review|\bpolitical party\b|\bthird[- ]party\b|\bparty line\b|\bparty of\b|\blabou?r party\b/;
const BENDER = /\bbender\b/;
const MORNING_MARKER =
  /\b(?:into|till|til|until|through)\s+(?:the\s+)?(?:(?:mon|tue|wed|thu|fri|sat|sun)\w*\s+)?(?:morning|afternoon|next day|sunrise|day)\b|\bdidn't sleep\b|\bdidnt sleep\b|\bno sleep\b|\bup all night\b|\ball night\b|\bwithout sleep\b/;
const HOME_TIME =
  /(?:\b(?:til|till|untill|until|tll|home (?:at|by|around|about|@)|got home (?:at|by|around|about|@)?|back (?:at|by|around))|->)\s*(?:around |about |~)?(\d{1,2})(?::?(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?![\w:])/g;

/** `HH:MM` for every home time in a text, in the order written. */
function homeTimes(text: string): string[] {
  const times: string[] = [];
  for (const match of text.matchAll(HOME_TIME)) {
    const raw = match[1] ?? "";
    const hourText = raw;
    let hour = Number(hourText);
    const minute = match[2] ? Number(match[2]) : 0;
    const suffix = (match[3] ?? "").replace(/\./g, "");
    if (minute > 59) continue;
    if (suffix) {
      if (hour < 1 || hour > 12) continue;
      hour = (hour % 12) + (suffix === "pm" ? 12 : 0);
    } else if (hourText.length === 2 && hourText.startsWith("0")) {
      // 0330: written as 24 hour time.
    } else if (hour === 12) {
      hour = 0;
    } else if (hour >= 7 && hour <= 11) {
      hour += 12;
    } else if (hour > 23) {
      continue;
    }
    times.push(
      `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    );
  }
  return times;
}

type NightRead = {
  homeAt: string | null;
  units: number | null;
  bender: boolean;
  needsCheck: boolean;
};

function readNight(sentence: string, whole: string): NightRead {
  const scope = (pattern: RegExp) =>
    pattern.test(sentence) ? sentence : whole;
  const times = homeTimes(scope(new RegExp(HOME_TIME.source)));
  const homeAt =
    [...times].sort((a, b) => nightOrder(b) - nightOrder(a))[0] ?? null;
  const fromTime = homeAt ? healthNightUnitsFor(homeAt) : null;
  const bender =
    BENDER.test(whole) ||
    MORNING_MARKER.test(whole) ||
    (fromTime?.bender ?? false);
  if (bender) {
    return { homeAt, units: 1, bender: true, needsCheck: false };
  }
  if (fromTime) {
    return {
      homeAt,
      units: fromTime.units,
      bender: false,
      needsCheck: false,
    };
  }
  return { homeAt: null, units: null, bender: false, needsCheck: true };
}

/** The day the evening started. */
function nightDay(
  sentence: string,
  whole: string,
  entryDay: string,
  entryHour: number,
): string {
  const lastWeek = LAST_WEEK.test(whole);
  const starts = [sentence, whole].flatMap((text) =>
    namedWeekdays(text).filter((day) => !day.endMarked),
  );
  const start = starts[0];
  if (start) return resolveWeekday(entryDay, start.index, lastWeek);
  const end = [sentence, whole].flatMap((text) => namedWeekdays(text))[0];
  if (end) {
    // "bender til thu morning": it ended Thursday, so it began Wednesday.
    return healthAddDays(resolveWeekday(entryDay, end.index, lastWeek), -1);
  }
  if (/\b(?:yesterday|last night|this morning|this am)\b/.test(whole)) {
    return healthAddDays(entryDay, -1);
  }
  if (/\b(?:tonight|today)\b/.test(whole)) return entryDay;
  return entryHour < 14 ? healthAddDays(entryDay, -1) : entryDay;
}

// --- The reader ------------------------------------------------------------------------------

/** Sentences of a normalised text; a time such as 3:30 does not split. */
function sentencesOf(text: string): string[] {
  return text
    .split(/[.!?;\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The pieces of a sentence a keyword is judged in. */
function clausesOf(sentence: string): string[] {
  return sentence
    .split(/,|\band\b|\bthen\b|\bplus\b|\+|&/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Reads one memo. Returns at most one entry per kind, in the order training,
 * breath, night_out. Never throws on odd text; an unparseable `createdAt`
 * throws, as it is a caller bug.
 */
export function healthParseMemo(input: HealthParseInput): HealthParsedEntry[] {
  if (healthMemoIsSkipped(input)) return [];
  const long = input.content.length >= healthLongMemoChars;
  const text = normalise(healthStripTimestampPrefix(input.content));
  if (!text.trim()) return [];
  const entry = healthLocalMoment(input.createdAt);
  const sentences = sentencesOf(text);
  const feel = feelWord(text);
  const retroWeekday = RETRO.test(text)
    ? namedWeekdays(text).find((day) => !day.endMarked)
    : undefined;
  const lastWeek = LAST_WEEK.test(text);

  /** A session's day: "yesterday", "<weekday> (forgot to log)", else the entry's. */
  const sessionDay = (sentence: string): string => {
    if (retroWeekday) {
      return resolveWeekday(entry.day, retroWeekday.index, lastWeek);
    }
    if (/\byesterday\b/.test(sentence)) return healthAddDays(entry.day, -1);
    return entry.day;
  };

  let training: (HealthParsedEntry & { rank: number }) | undefined;
  let breath: HealthParsedEntry | undefined;
  let night: HealthParsedEntry | undefined;

  for (const sentence of sentences) {
    const planned = PLAN.test(sentence) && !DONE.test(sentence);
    const nightPlanned = PLAN_FOR_NIGHT.test(sentence) && !DONE.test(sentence);
    const longAllows = (explicit: boolean) =>
      !long || explicit || DONE.test(sentence);

    if (!planned) {
      for (const clause of clausesOf(sentence)) {
        const hit = trainingHit(clause);
        if (hit && longAllows(hit.explicit)) {
          if (!training || hit.rank > training.rank) {
            training = {
              rank: hit.rank,
              kind: "training",
              day: sessionDay(sentence),
              variant: hit.variant,
              minutes: hit.minutes,
              homeAt: null,
              units: null,
              bender: false,
              needsCheck: false,
              feel,
            };
          }
        }
        if (!breath) {
          const breathing = breathHit(clause, sentence);
          if (breathing && longAllows(breathing.explicit)) {
            breath = {
              kind: "breath",
              day: sessionDay(sentence),
              variant: breathing.variant,
              minutes: breathing.minutes,
              homeAt: null,
              units: null,
              bender: false,
              needsCheck: false,
              feel,
            };
          }
        }
      }
    }

    if (!night && !nightPlanned) {
      const strong = NIGHT_STRONG.exec(sentence);
      const weak = strong ? null : NIGHT_WEAK.exec(sentence);
      const keyword = strong ?? weak;
      if (
        keyword &&
        !negatedAt(sentence, keyword.index, keyword[0].length) &&
        !(weak && NIGHT_NOT.test(sentence))
      ) {
        const read = readNight(sentence, text);
        const hasTime = read.homeAt !== null || MORNING_MARKER.test(text);
        const hasDay =
          namedWeekdays(text).length > 0 ||
          /\b(?:last night|yesterday|this morning|tonight)\b/.test(text);
        // `club`, `party`, `rave` and `festival` are everyday words: they need a
        // time, a day or a done word before they mean a night out.
        const weakOk = !weak || hasTime || hasDay || DONE.test(sentence);
        const tagged = /#out(?![\w-])/.test(sentence);
        const longOk =
          !long || tagged || DONE.test(sentence) || read.homeAt !== null;
        if (weakOk && longOk) {
          night = {
            kind: "night_out",
            day: nightDay(sentence, text, entry.day, entry.hour),
            variant: null,
            minutes: null,
            homeAt: read.homeAt,
            units: read.units,
            bender: read.bender,
            needsCheck: read.needsCheck,
            feel: null,
          };
        }
      }
    }
  }

  const entries: HealthParsedEntry[] = [];
  if (training) {
    const { rank: _rank, ...rest } = training;
    entries.push(rest);
  }
  if (breath) entries.push(breath);
  if (night) entries.push(night);
  return entries;
}
