import type { HealthEntryDto } from "@flaremo/contracts";

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
