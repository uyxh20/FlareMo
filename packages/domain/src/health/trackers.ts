import {
  type HealthBuiltinWordsInput,
  type HealthEntryKind,
  type HealthKind,
  type HealthTrackerColor,
  type HealthTrackerDraft,
  type HealthTrackerDto,
  type HealthTrackerInput,
  type HealthTrackerKind,
  type HealthTrackerMeasure,
  type HealthTrackerPreviewResponse,
  type HealthTrackerTestResponse,
  healthBuiltinWords,
  healthIsBuiltinKind,
  healthKinds,
  healthMaxTrackers,
  healthTrackerColors,
} from "@flaremo/contracts";
import type { FlareMoDb } from "@flaremo/db";
import {
  type HealthTrackerRow,
  healthTracker,
  healthTrackerEvent,
} from "@flaremo/db/src/schema/fork-health";
import { plannerGoal } from "@flaremo/db/src/schema/planner";
import { and, eq, isNull } from "drizzle-orm";
import { NotFoundError, ValidationError } from "../errors";
import {
  type HealthParseConfig,
  type HealthParseTracker,
  healthExplainTracker,
} from "./parse";

// Trackers the owner edits in the app (fork-owned add-on,
// docs/fork-health-tracker.md, "Trackers"). A tracker is a list of words and
// tags the diary is read for: a new habit (fasting, say) is one row here, and a
// built-in kind takes extra words and blocked words on top of its fixed reader.
// Every save writes its event in the same batch and is followed by a re-read
// of the diary (the caller runs healthRescan). Nothing is hard-deleted: an
// archived tracker's rows are soft-deleted by that re-read.

type BatchItems = Parameters<FlareMoDb["batch"]>[0];

const BUILTIN_LABELS: Record<HealthKind, string> = {
  training: "Training",
  breath: "Breath",
  night_out: "Nights out",
};

function parseWords(json: string): string[] {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter((word): word is string => typeof word === "string")
      : [];
  } catch {
    return [];
  }
}

function isMissingTable(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    const message =
      current instanceof Error ? current.message : String(current);
    if (/no such table/i.test(message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

/**
 * Every tracker row of a user, archived ones included. A database without the
 * table (migration 9011 not applied yet) reads as none, so the diary is still
 * read with the fixed rules.
 */
export async function healthReadTrackerRows(
  db: FlareMoDb,
  userId: string,
): Promise<HealthTrackerRow[]> {
  try {
    return await db
      .select()
      .from(healthTracker)
      .where(eq(healthTracker.userId, userId))
      .all();
  } catch (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }
}

/** What the reader needs from the owner's trackers. */
export function healthParseConfigOf(
  rows: readonly HealthTrackerRow[],
): HealthParseConfig {
  const trackers: HealthParseTracker[] = [];
  const builtins: NonNullable<HealthParseConfig["builtins"]> = {};
  for (const row of rows) {
    if (row.archivedAt !== null) continue;
    const words = parseWords(row.wordsJson);
    const blocked = parseWords(row.blockedJson);
    if (healthIsBuiltinKind(row.kind)) {
      if (words.length > 0 || blocked.length > 0) {
        builtins[row.kind] = { words, blocked };
      }
    } else if (words.length > 0) {
      trackers.push({
        kind: row.kind as HealthTrackerKind,
        measure: row.measure,
        words,
        blocked,
      });
    }
  }
  return { trackers, builtins };
}

export async function healthReadParseConfig(
  db: FlareMoDb,
  userId: string,
): Promise<HealthParseConfig> {
  return healthParseConfigOf(await healthReadTrackerRows(db, userId));
}

function sortTrackers(rows: HealthTrackerRow[]): HealthTrackerRow[] {
  return [...rows].sort(
    (a, b) => a.sortOrder - b.sortOrder || (a.createdAt < b.createdAt ? -1 : 1),
  );
}

function toDto(row: HealthTrackerRow): HealthTrackerDto {
  const builtin = healthIsBuiltinKind(row.kind);
  return {
    id: row.id,
    kind: row.kind,
    label: builtin ? BUILTIN_LABELS[row.kind as HealthKind] : row.label,
    color: builtin
      ? null
      : (healthTrackerColors as readonly string[]).includes(row.color)
        ? (row.color as HealthTrackerColor)
        : "green",
    measure: row.measure,
    words: parseWords(row.wordsJson),
    blocked: parseWords(row.blockedJson),
    goal_id: row.goalId,
    builtin,
    fixed_words: builtin ? [...healthBuiltinWords[row.kind as HealthKind]] : [],
    updated_at: row.updatedAt,
  };
}

function builtinDto(kind: HealthKind): HealthTrackerDto {
  return {
    id: kind,
    kind,
    label: BUILTIN_LABELS[kind],
    color: null,
    measure: kind === "breath" ? "minutes" : "days",
    words: [],
    blocked: [],
    goal_id: null,
    builtin: true,
    fixed_words: [...healthBuiltinWords[kind]],
    updated_at: null,
  };
}

/**
 * The trackers as the app lists them: the three built-ins first (with the
 * owner's extra words when they set any), then the owner's own, live ones only.
 */
export async function healthListTrackers(
  db: FlareMoDb,
  userId: string,
): Promise<HealthTrackerDto[]> {
  const rows = await healthReadTrackerRows(db, userId);
  const builtins = healthKinds.map((kind) => {
    const row = rows.find((candidate) => candidate.kind === kind);
    return row ? { ...toDto(row), id: kind } : builtinDto(kind);
  });
  const own = sortTrackers(
    rows.filter(
      (row) => !healthIsBuiltinKind(row.kind) && row.archivedAt === null,
    ),
  ).map(toDto);
  return [...builtins, ...own];
}

/** The live trackers' kinds and labels, in the app's order (built-ins first). */
export async function healthReadTrackerKinds(
  db: FlareMoDb,
  userId: string,
): Promise<HealthEntryKind[]> {
  const rows = await healthReadTrackerRows(db, userId);
  return sortTrackers(
    rows.filter(
      (row) => !healthIsBuiltinKind(row.kind) && row.archivedAt === null,
    ),
  ).map((row) => row.kind);
}

// --- Writes ------------------------------------------------------------------------

function snapshot(row: HealthTrackerRow): string {
  return JSON.stringify({
    kind: row.kind,
    label: row.label,
    color: row.color,
    measure: row.measure,
    words: parseWords(row.wordsJson),
    blocked: parseWords(row.blockedJson),
    goalId: row.goalId,
    archivedAt: row.archivedAt,
  });
}

function eventOf(
  db: FlareMoDb,
  action: "create" | "update" | "archive" | "restore",
  before: HealthTrackerRow | null,
  after: HealthTrackerRow,
  at: string,
) {
  return db.insert(healthTrackerEvent).values({
    id: crypto.randomUUID(),
    trackerId: after.id,
    userId: after.userId,
    action,
    beforeJson: before ? snapshot(before) : null,
    afterJson: snapshot(after),
    at,
  });
}

async function assertGoal(
  db: FlareMoDb,
  userId: string,
  goalId: string | null,
): Promise<void> {
  if (!goalId) return;
  const goal = await db
    .select({ id: plannerGoal.id })
    .from(plannerGoal)
    .where(
      and(
        eq(plannerGoal.id, goalId),
        eq(plannerGoal.userId, userId),
        isNull(plannerGoal.deletedAt),
      ),
    )
    .get();
  if (!goal) throw new ValidationError("That goal does not exist.");
}

/** A short lower-case id; the tracker's kind is `t:` and this. */
function newTrackerId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

function assertWordsDiffer(words: string[], blocked: string[]): void {
  const both = words.find((word) => blocked.includes(word));
  if (both) {
    throw new ValidationError(`"${both}" cannot both count and be blocked.`);
  }
}

export async function healthCreateTracker(
  db: FlareMoDb,
  input: { userId: string; tracker: HealthTrackerInput; now?: Date },
): Promise<HealthTrackerRow> {
  const { tracker } = input;
  if (tracker.words.length === 0) {
    throw new ValidationError("A tracker needs at least one word or tag.");
  }
  assertWordsDiffer(tracker.words, tracker.blocked);
  await assertGoal(db, input.userId, tracker.goal_id);
  const rows = await healthReadTrackerRows(db, input.userId);
  const live = rows.filter(
    (row) => !healthIsBuiltinKind(row.kind) && row.archivedAt === null,
  );
  if (live.length >= healthMaxTrackers) {
    throw new ValidationError(
      `You can have at most ${healthMaxTrackers} trackers.`,
    );
  }
  const at = (input.now ?? new Date()).toISOString();
  const id = newTrackerId();
  const row: HealthTrackerRow = {
    id,
    userId: input.userId,
    kind: `t:${id}`,
    label: tracker.label,
    color: tracker.color,
    measure: tracker.measure,
    wordsJson: JSON.stringify(tracker.words),
    blockedJson: JSON.stringify(tracker.blocked),
    goalId: tracker.goal_id,
    builtin: false,
    sortOrder: Math.max(0, ...live.map((other) => other.sortOrder + 1)),
    archivedAt: null,
    createdAt: at,
    updatedAt: at,
  };
  await db.batch([
    db.insert(healthTracker).values(row),
    eventOf(db, "create", null, row, at),
  ] as unknown as BatchItems);
  return row;
}

async function readOwnTracker(
  db: FlareMoDb,
  userId: string,
  id: string,
): Promise<HealthTrackerRow> {
  const row = (await healthReadTrackerRows(db, userId)).find(
    (candidate) => candidate.id === id && !healthIsBuiltinKind(candidate.kind),
  );
  if (!row) throw new NotFoundError("Tracker not found");
  return row;
}

export async function healthUpdateTracker(
  db: FlareMoDb,
  input: {
    userId: string;
    id: string;
    tracker: HealthTrackerInput;
    now?: Date;
  },
): Promise<HealthTrackerRow> {
  const { tracker } = input;
  if (tracker.words.length === 0) {
    throw new ValidationError("A tracker needs at least one word or tag.");
  }
  assertWordsDiffer(tracker.words, tracker.blocked);
  await assertGoal(db, input.userId, tracker.goal_id);
  const before = await readOwnTracker(db, input.userId, input.id);
  if (before.archivedAt !== null) throw new NotFoundError("Tracker not found");
  const at = (input.now ?? new Date()).toISOString();
  const after: HealthTrackerRow = {
    ...before,
    label: tracker.label,
    color: tracker.color,
    measure: tracker.measure,
    wordsJson: JSON.stringify(tracker.words),
    blockedJson: JSON.stringify(tracker.blocked),
    goalId: tracker.goal_id,
    updatedAt: at,
  };
  await db.batch([
    db
      .update(healthTracker)
      .set({
        label: after.label,
        color: after.color,
        measure: after.measure,
        wordsJson: after.wordsJson,
        blockedJson: after.blockedJson,
        goalId: after.goalId,
        updatedAt: at,
      })
      .where(eq(healthTracker.id, before.id)),
    eventOf(db, "update", before, after, at),
  ] as unknown as BatchItems);
  return after;
}

/** Hides a tracker. The re-read that follows soft-deletes its rows. */
export async function healthArchiveTracker(
  db: FlareMoDb,
  input: { userId: string; id: string; now?: Date },
): Promise<void> {
  const before = await readOwnTracker(db, input.userId, input.id);
  if (before.archivedAt !== null) return;
  const at = (input.now ?? new Date()).toISOString();
  const after = { ...before, archivedAt: at, updatedAt: at };
  await db.batch([
    db
      .update(healthTracker)
      .set({ archivedAt: at, updatedAt: at })
      .where(eq(healthTracker.id, before.id)),
    eventOf(db, "archive", before, after, at),
  ] as unknown as BatchItems);
}

/** Sets a built-in kind's extra words and blocked words. */
export async function healthSetBuiltinWords(
  db: FlareMoDb,
  input: {
    userId: string;
    kind: HealthKind;
    words: HealthBuiltinWordsInput;
    now?: Date;
  },
): Promise<HealthTrackerRow> {
  assertWordsDiffer(input.words.words, input.words.blocked);
  const at = (input.now ?? new Date()).toISOString();
  const before = (await healthReadTrackerRows(db, input.userId)).find(
    (row) => row.kind === input.kind,
  );
  if (!before) {
    const row: HealthTrackerRow = {
      id: newTrackerId(),
      userId: input.userId,
      kind: input.kind,
      label: BUILTIN_LABELS[input.kind],
      color: "",
      measure: input.kind === "breath" ? "minutes" : "days",
      wordsJson: JSON.stringify(input.words.words),
      blockedJson: JSON.stringify(input.words.blocked),
      goalId: null,
      builtin: true,
      sortOrder: 0,
      archivedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    await db.batch([
      db.insert(healthTracker).values(row),
      eventOf(db, "create", null, row, at),
    ] as unknown as BatchItems);
    return row;
  }
  const after: HealthTrackerRow = {
    ...before,
    wordsJson: JSON.stringify(input.words.words),
    blockedJson: JSON.stringify(input.words.blocked),
    updatedAt: at,
  };
  await db.batch([
    db
      .update(healthTracker)
      .set({
        wordsJson: after.wordsJson,
        blockedJson: after.blockedJson,
        updatedAt: at,
      })
      .where(eq(healthTracker.id, before.id)),
    eventOf(db, "update", before, after, at),
  ] as unknown as BatchItems);
  return after;
}

// --- Drafts: test a sentence, preview a change -------------------------------------

/** The kind a draft is about: a built-in, an existing tracker, or a new one. */
export function healthDraftKind(
  rows: readonly HealthTrackerRow[],
  draft: HealthTrackerDraft,
): HealthEntryKind {
  if (draft.id && healthIsBuiltinKind(draft.id)) return draft.id;
  if (draft.id) {
    const row = rows.find(
      (candidate) =>
        candidate.id === draft.id && !healthIsBuiltinKind(candidate.kind),
    );
    if (!row) throw new NotFoundError("Tracker not found");
    return row.kind;
  }
  return "t:draft";
}

/** The reader's config with one tracker replaced by a draft. */
export function healthConfigWithDraft(
  rows: readonly HealthTrackerRow[],
  draft: HealthTrackerDraft,
): { kind: HealthEntryKind; config: HealthParseConfig } {
  const kind = healthDraftKind(rows, draft);
  const current = healthParseConfigOf(rows);
  if (healthIsBuiltinKind(kind)) {
    return {
      kind,
      config: {
        trackers: current.trackers,
        builtins: {
          ...current.builtins,
          [kind]: { words: draft.words, blocked: draft.blocked },
        },
      },
    };
  }
  const trackerKind = kind as HealthTrackerKind;
  return {
    kind,
    config: {
      builtins: current.builtins,
      trackers: [
        ...(current.trackers ?? []).filter(
          (tracker) => tracker.kind !== trackerKind,
        ),
        {
          kind: trackerKind,
          measure: draft.measure as HealthTrackerMeasure,
          words: draft.words,
          blocked: draft.blocked,
        },
      ],
    },
  };
}

/** Why one sentence counts or not for a draft's words. */
export function healthTestTracker(input: {
  text: string;
  draft: HealthTrackerDraft;
}): HealthTrackerTestResponse {
  const result = healthExplainTracker({
    text: input.text,
    measure: input.draft.measure,
    words: input.draft.words,
    blocked: input.draft.blocked,
    night: input.draft.id === "night_out",
  });
  return {
    reason: result.reason,
    match: result.match,
    day_offset: result.dayOffset,
    minutes: result.minutes,
  };
}

/** An empty preview, the shape healthPreviewTracker fills in. */
export function healthEmptyPreview(): HealthTrackerPreviewResponse {
  return {
    added: 0,
    removed: 0,
    kept: 0,
    unchanged: 0,
    added_days: [],
    removed_days: [],
    memos: 0,
  };
}
