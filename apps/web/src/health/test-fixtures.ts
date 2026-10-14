import type { HealthEntryDto, HealthTrackerDto } from "@flaremo/contracts";

// Entries for the health tests (not imported by the app). The notes they stand
// for are invented.

export function healthTestEntry(
  overrides: Partial<HealthEntryDto> = {},
): HealthEntryDto {
  return {
    id: "he-1",
    kind: "training",
    day: "2026-10-12",
    variant: "gym",
    minutes: null,
    home_at: null,
    units: null,
    bender: false,
    needs_check: false,
    feel: null,
    source: "memo",
    memo_id: "m1",
    edited: false,
    created_at: "2026-10-12T18:00:00.000Z",
    updated_at: "2026-10-12T18:00:00.000Z",
    ...overrides,
  };
}

export function healthTestNight(
  overrides: Partial<HealthEntryDto> = {},
): HealthEntryDto {
  return healthTestEntry({
    id: "he-night",
    kind: "night_out",
    variant: null,
    ...overrides,
  });
}

/** The tracker list as the server sends it: the built-ins, then Fasting. */
export function healthTestTrackers(): HealthTrackerDto[] {
  const builtin = (
    kind: "training" | "breath" | "night_out",
    label: string,
  ): HealthTrackerDto => ({
    id: kind,
    kind,
    label,
    color: null,
    measure: kind === "breath" ? "minutes" : "days",
    words: [],
    blocked: [],
    goal_id: null,
    builtin: true,
    fixed_words: ["#gym"],
    updated_at: null,
  });
  return [
    builtin("training", "Training"),
    builtin("breath", "Breath"),
    builtin("night_out", "Nights out"),
    {
      id: "fast00000001",
      kind: "t:fast00000001",
      label: "Fasting",
      color: "green",
      measure: "hours",
      words: ["#fast", "fasted"],
      blocked: [],
      goal_id: null,
      builtin: false,
      fixed_words: [],
      updated_at: "2026-10-12T18:00:00.000Z",
    },
  ];
}
