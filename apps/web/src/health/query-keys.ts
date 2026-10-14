// Query keys for the health tracker (fork-owned add-on,
// docs/fork-health-tracker.md). Everything lives under ["health", ...], so one
// prefix refreshes the whole tracker.

export const healthQueryKeys = {
  all: ["health"] as const,
  /** One memo's labels. `stamp` is its update time, so an edited memo asks again. */
  memo: (memoId: string, stamp: string) =>
    ["health", "memo", memoId, stamp] as const,
  /** Every cached label of one memo, whatever its stamp. */
  memoPrefix: (memoId: string) => ["health", "memo", memoId] as const,
  strip: (start: string) => ["health", "strip", start] as const,
  stripAll: ["health", "strip"] as const,
  week: (start: string) => ["health", "week", start] as const,
  year: (year: number) => ["health", "year", year] as const,
  trackers: ["health", "trackers"] as const,
} as const;
