import type { Memo } from "@/api";
import { stripResourceName } from "@/lib/utils";

export function getMemoResourceId(memo: Memo) {
  return stripResourceName(memo.name, "memos");
}

export function extractTags(content: string) {
  const tags = new Set<string>();
  for (const match of content.matchAll(/(^|\s)#([\p{L}\p{N}_-]+)/gu)) {
    tags.add(match[2]);
  }
  return [...tags];
}

/**
 * Absolute timestamp for a memo. The year is only spelled out when it differs
 * from the current one: imported backfills routinely span many years (issue
 * #143), and two memos from the same month/day in different years used to be
 * indistinguishable in the timeline. Future-dated rows (clock skew, dirty
 * imports) take the same branch, so a future year is never shown year-less.
 */
export function formatMemoTime(value: string, locale?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

/**
 * Timeline timestamps read as relative time ("3 hours ago" / "3 小时前")
 * for the past week and fall back to an absolute date beyond that.
 */
export function formatMemoRelativeTime(value: string, locale?: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  if (absSeconds >= 7 * 86_400) return formatMemoTime(value, locale);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (absSeconds < 45) return rtf.format(0, "second");
  if (absSeconds < 3_600)
    return rtf.format(Math.round(diffSeconds / 60), "minute");
  if (absSeconds < 86_400)
    return rtf.format(Math.round(diffSeconds / 3_600), "hour");
  return rtf.format(Math.round(diffSeconds / 86_400), "day");
}
