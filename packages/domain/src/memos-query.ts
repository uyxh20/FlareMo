import type { MemoOrderBy } from "@flaremo/contracts";
import { ValidationError } from "./errors";

type MemoCursor = {
  id: string;
  orderBy: MemoOrderBy;
  pinned: boolean;
  sortValue: string;
};

export function encodePageToken(value: MemoCursor) {
  return btoa(JSON.stringify(value));
}

export function decodePageToken(
  token: string,
  orderBy: MemoOrderBy,
): MemoCursor {
  try {
    const parsed = JSON.parse(atob(token)) as Partial<MemoCursor>;
    if (
      typeof parsed.sortValue === "string" &&
      typeof parsed.id === "string" &&
      typeof parsed.pinned === "boolean" &&
      parsed.orderBy === orderBy
    ) {
      return parsed as MemoCursor;
    }
  } catch {
    // The validation error below gives callers one stable failure shape.
  }
  throw new ValidationError("Invalid page token");
}

export function buildFtsQuery(value: string) {
  const trimmed = value.trim();
  if (!trimmed || !/^[\p{Script=Latin}\p{N}\s_-]+$/u.test(trimmed)) {
    return undefined;
  }
  const terms = trimmed.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  return terms.length > 0
    ? terms.map((term) => `"${term.replaceAll('"', '""')}"*`).join(" AND ")
    : undefined;
}

export function escapeLike(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}

export function memoSearchScopeToState(
  scope: "timeline" | "archive" | "trash" | undefined,
) {
  if (scope === "timeline") return "normal" as const;
  if (scope === "archive") return "archived" as const;
  if (scope === "trash") return "trashed" as const;
  return undefined;
}

export function toUtcDayStart(date: string) {
  return `${date}T00:00:00.000Z`;
}

export function createDateKeyFormatter(timeZone: string) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    });
  } catch {
    throw new ValidationError("Invalid time zone");
  }

  return (date: Date) => {
    const parts = Object.fromEntries(
      formatter
        .formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value]),
    );
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
}

/**
 * The trailing `days`-long window of local dates ending on `anchorKey`, each
 * paired with its memo count (0 when absent).
 *
 * `days` is a parameter rather than the hardcoded 84 the heatmap used to
 * assume: the year view needs 366, and a client that only renders a month
 * should not pay for a year. Callers clamp it at the contract boundary. The
 * anchor is usually today, but the year view pins it to the navigated year's
 * Dec 31 so historical years reach their own cells (issue #144).
 */
export function buildActivity(
  anchorKey: string,
  counts: Map<string, number>,
  days = 84,
) {
  const anchor = new Date(`${anchorKey}T00:00:00Z`);
  const result: Array<{ count: number; date: string }> = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(anchor);
    date.setUTCDate(anchor.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    result.push({ count: counts.get(key) ?? 0, date: key });
  }
  return result;
}
