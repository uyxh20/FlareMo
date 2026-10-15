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
  /** One week from its Monday: the diary strip and the Health page share it. */
  week: (start: string) => ["health", "week", start] as const,
  weekAll: ["health", "week"] as const,
  year: (year: number) => ["health", "year", year] as const,
  trackers: ["health", "trackers"] as const,
  /** Tracker counts over each linked goal's period, for the goal cards. */
  goalProgress: ["health", "goal-progress"] as const,
} as const;
