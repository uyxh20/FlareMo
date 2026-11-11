import type { PlannerMorningResponse } from "@flaremo/contracts";
import { apiRequest } from "@/api/client";

// The morning page's HTTP client (fork-owned add-on,
// docs/fork-customizations.md "Morning page"; routes in
// packages/contracts/src/planner-morning.ts). `today` is the local date.

const MORNING_API = "/api/app/planner/morning";

/** The day's line, if one is written, and whether the page was dismissed. Never calls a model. */
export function plannerFetchMorning(today: string) {
  return apiRequest<PlannerMorningResponse>(
    `${MORNING_API}?${new URLSearchParams({ today })}`,
  );
}

/** Today's line, written on the first call of the day; with `replace`, a new one ("Another"). */
export function plannerMorningLineRequest(today: string, replace?: string) {
  return apiRequest<PlannerMorningResponse>(`${MORNING_API}/line`, {
    method: "POST",
    body: JSON.stringify(replace ? { today, replace } : { today }),
  });
}

/** "Start the day": dismissed for the rest of the day, and the line on screen kept. */
export function plannerMorningDismissRequest(
  today: string,
  lineId: string | null,
) {
  return apiRequest<PlannerMorningResponse>(`${MORNING_API}/dismiss`, {
    method: "POST",
    body: JSON.stringify({ today, line_id: lineId }),
  });
}

// What this browser already knows, so the diary does not ask the server on
// every open once the page was dismissed, and does not send the owner back to
// the page they just left this session. Storage can be missing (private mode):
// every read and write is guarded, and a miss only costs one request.

const DISMISSED_KEY = "schizo-diary.morning.dismissed";
const OPENED_KEY = "schizo-diary.morning.opened";

function read(storage: () => Storage, key: string): string | null {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
}

function write(storage: () => Storage, key: string, value: string) {
  try {
    storage().setItem(key, value);
  } catch {
    // Nothing to do: the server still knows.
  }
}

export const plannerMorningMemory = {
  dismissed: (today: string) =>
    read(() => localStorage, DISMISSED_KEY) === today,
  markDismissed: (today: string) =>
    write(() => localStorage, DISMISSED_KEY, today),
  opened: (today: string) => read(() => sessionStorage, OPENED_KEY) === today,
  markOpened: (today: string) => write(() => sessionStorage, OPENED_KEY, today),
};
