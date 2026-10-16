import type {
  PlannerPeriodAiChecksResponse,
  PlannerPeriodAiCoachInput,
  PlannerPeriodAiMemoInput,
  PlannerPeriodAiThemesResponse,
  PlannerPeriodLevel,
  PlannerPeriodReviewResponse,
  PlannerPeriodStateResponse,
  PlannerPeriodStatusResponse,
  PlannerSavePeriodInput,
  PlannerSavePeriodResponse,
} from "@flaremo/contracts";
import { apiRequest } from "@/api/client";
import { plannerFitsKeepalive } from "./api";
import { plannerReadAiStream } from "./goals-api";

// The month, quarter and year reviews over HTTP (fork-owned add-on,
// docs/planning-cockpit-period-review.md): the routes listed in
// packages/contracts/src/planner-period-review.ts, typed from the contracts
// like the weekly review's client (goals-api.ts), whose NDJSON reader the two
// streaming calls share.

const PLANNER_API = "/api/app/planner";

const periodPath = (level: PlannerPeriodLevel, period: string, rest: string) =>
  `${PLANNER_API}/period-review/${level}/${encodeURIComponent(period)}/${rest}`;

export function plannerFetchPeriodReview(input: {
  today: string;
  level?: PlannerPeriodLevel;
  period?: string;
}) {
  const query = new URLSearchParams({ today: input.today });
  if (input.level) query.set("level", input.level);
  if (input.period) query.set("period", input.period);
  return apiRequest<PlannerPeriodReviewResponse>(
    `${PLANNER_API}/period-review?${query}`,
  );
}

export function plannerFetchPeriodStatus(today: string) {
  const query = new URLSearchParams({ today });
  return apiRequest<PlannerPeriodStatusResponse>(
    `${PLANNER_API}/period-review/status?${query}`,
  );
}

export function plannerSavePeriodStateRequest(
  level: PlannerPeriodLevel,
  period: string,
  state: Record<string, unknown>,
  options: { keepalive?: boolean } = {},
) {
  const body = JSON.stringify({ state });
  return apiRequest<PlannerPeriodStateResponse>(
    periodPath(level, period, "state"),
    {
      method: "PATCH",
      body,
      ...(options.keepalive && plannerFitsKeepalive(body)
        ? { keepalive: true }
        : {}),
    },
  );
}

export function plannerStartPeriodOverRequest(
  level: PlannerPeriodLevel,
  period: string,
) {
  return apiRequest<PlannerPeriodStateResponse>(
    periodPath(level, period, "start-over"),
    { method: "POST" },
  );
}

export function plannerSavePeriodRequest(
  level: PlannerPeriodLevel,
  period: string,
  input: PlannerSavePeriodInput,
) {
  return apiRequest<PlannerSavePeriodResponse>(
    periodPath(level, period, "save"),
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function plannerPeriodChecksRequest(
  level: PlannerPeriodLevel,
  period: string,
  today: string,
) {
  return apiRequest<PlannerPeriodAiChecksResponse>(
    periodPath(level, period, "ai/checks"),
    { method: "POST", body: JSON.stringify({ today }) },
  );
}

export function plannerPeriodThemesRequest(
  level: PlannerPeriodLevel,
  period: string,
  today: string,
) {
  return apiRequest<PlannerPeriodAiThemesResponse>(
    periodPath(level, period, "ai/themes"),
    { method: "POST", body: JSON.stringify({ today }) },
  );
}

export function plannerStreamPeriodCoach(
  level: PlannerPeriodLevel,
  period: string,
  input: PlannerPeriodAiCoachInput,
  options: { signal?: AbortSignal; onText?: (text: string) => void },
) {
  return plannerReadAiStream(
    periodPath(level, period, "ai/coach"),
    input,
    options,
  );
}

export function plannerStreamPeriodMemo(
  level: PlannerPeriodLevel,
  period: string,
  input: PlannerPeriodAiMemoInput,
  options: { signal?: AbortSignal; onText?: (text: string) => void },
) {
  return plannerReadAiStream(
    periodPath(level, period, "ai/memo"),
    input,
    options,
  );
}
