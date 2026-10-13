import type {
  HealthEntryDto,
  HealthEntryResponse,
  HealthMemosResponse,
  HealthPatchEntryInput,
  HealthRescanResponse,
  HealthWeekResponse,
  HealthYearResponse,
} from "@flaremo/contracts";
import { apiRequest } from "@/api/client";

// The health tracker's HTTP client (fork-owned add-on, docs/fork-health-tracker.md):
// a thin typed layer over `apiRequest`, with the types straight from
// @flaremo/contracts. The server owns every rule.
//
// The path is /api/app/health-tracker, not /api/app/health: that exact path is
// upstream's instance info endpoint.

const HEALTH_API = "/api/app/health-tracker";

export function healthFetchWeek(start?: string) {
  const query = start ? `?${new URLSearchParams({ start })}` : "";
  return apiRequest<HealthWeekResponse>(`${HEALTH_API}/week${query}`);
}

export function healthFetchYear(year: number) {
  return apiRequest<HealthYearResponse>(`${HEALTH_API}/year?year=${year}`);
}

export function healthPatchEntryRequest(
  entryId: string,
  patch: HealthPatchEntryInput,
) {
  return apiRequest<HealthEntryResponse>(
    `${HEALTH_API}/entries/${encodeURIComponent(entryId)}`,
    { method: "PATCH", body: JSON.stringify(patch) },
  );
}

export function healthDismissRequest(entryId: string) {
  return apiRequest<HealthEntryResponse>(
    `${HEALTH_API}/entries/${encodeURIComponent(entryId)}/dismiss`,
    { method: "POST" },
  );
}

export function healthRescanRequest() {
  return apiRequest<HealthRescanResponse>(`${HEALTH_API}/rescan`, {
    method: "POST",
  });
}

// --- One request for a whole page of labels ------------------------------------

/** The server takes up to 100 ids per request. */
const MAX_IDS = 100;
/** Cards of one page mount within a frame or two; this gathers them. */
const BATCH_WINDOW_MS = 25;

type Waiting = {
  id: string;
  resolve: (entries: HealthEntryDto[]) => void;
  reject: (error: unknown) => void;
};

let waiting: Waiting[] = [];
let scheduled = false;

async function flush() {
  const batch = waiting;
  waiting = [];
  scheduled = false;
  for (let start = 0; start < batch.length; start += MAX_IDS) {
    const chunk = batch.slice(start, start + MAX_IDS);
    const ids = [...new Set(chunk.map((item) => item.id))];
    try {
      const response = await apiRequest<HealthMemosResponse>(
        `${HEALTH_API}/memos?${new URLSearchParams({ ids: ids.join(",") })}`,
      );
      for (const item of chunk) {
        item.resolve(response.memos[item.id] ?? []);
      }
    } catch (error) {
      for (const item of chunk) item.reject(error);
    }
  }
}

/**
 * The labels of one memo. Calls made in the same moment (every card of a page
 * mounting) travel as ONE request: `GET /memos?ids=a,b,c`.
 */
export function healthLoadMemoEntries(
  memoId: string,
): Promise<HealthEntryDto[]> {
  return new Promise((resolve, reject) => {
    waiting.push({ id: memoId, resolve, reject });
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => void flush(), BATCH_WINDOW_MS);
    }
  });
}
