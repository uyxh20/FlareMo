// @vitest-environment jsdom
import type {
  HealthWeekResponse,
  HealthYearResponse,
} from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PlannerTestMount,
  plannerTestClick,
  plannerTestMount,
} from "@/planner/test-render";
import {
  healthFetchWeek,
  healthFetchYear,
  healthPatchEntryRequest,
  healthRescanRequest,
} from "./api";
import { HealthPage } from "./health-page";
import { healthTestEntry, healthTestNight } from "./test-fixtures";

// The Health page: the week against its targets, the night-out budget and pace,
// the nights that need a home time, the year grid and the re-read button. The
// workspace chrome (sidebar, header) is replaced by a bare frame, and the network
// by canned answers.

vi.mock("@/components/workspace/workspace-layout", () => ({
  WorkspaceLayout: ({ children }: { children: React.ReactNode }) => (
    <main>{children}</main>
  ),
}));
vi.mock("@/components/workspace/workspace-page-header", () => ({
  WorkspacePageHeader: () => null,
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  healthFetchWeek: vi.fn(),
  healthFetchYear: vi.fn(),
  healthPatchEntryRequest: vi.fn(),
  healthRescanRequest: vi.fn(),
}));

const fetchWeek = vi.mocked(healthFetchWeek);
const fetchYear = vi.mocked(healthFetchYear);
const patch = vi.mocked(healthPatchEntryRequest);
const rescan = vi.mocked(healthRescanRequest);

const NEEDS = healthTestNight({
  id: "n9",
  day: "2026-10-09",
  needs_check: true,
  units: null,
});

const WEEK: HealthWeekResponse = {
  start: "2026-10-07",
  end: "2026-10-13",
  today: "2026-10-13",
  entries: [healthTestEntry({ day: "2026-10-12" }), NEEDS],
  summary: {
    training: { sessions: 2, target: 3 },
    breath: { days: 5, sessions: 5, minutes: 50, target: 7 },
    night_out: {
      units: 1.5,
      nights: 2,
      needs_check: 1,
      year_target: 12,
      year_used: 6,
    },
  },
};

const YEAR: HealthYearResponse = {
  year: 2026,
  today: "2026-10-13",
  days: [
    {
      day: "2026-10-12",
      training: 1,
      breath: 1,
      night_out: null,
      has_night: false,
      needs_check: false,
    },
  ],
  night_out: {
    used: 6,
    target: 12,
    days_elapsed: 286,
    pace: 7.7,
    nights: 9,
    benders: 2,
    needs_check: 1,
  },
  totals: { training: 31, breath_days: 140 },
  needs_check_entries: [NEEDS],
};

let mounted: PlannerTestMount | undefined;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function show() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-13T09:00:00Z"));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mounted = plannerTestMount(<HealthPage />, { queryClient });
  await settle();
  return mounted.container;
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchWeek.mockResolvedValue(WEEK);
  fetchYear.mockResolvedValue(YEAR);
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
});

describe("the Health page", () => {
  it("asks for the current year", async () => {
    await show();
    expect(fetchYear).toHaveBeenCalledWith(2026);
  });

  it("shows the week against its targets", async () => {
    const container = await show();
    const tiles = Array.from(
      container.querySelectorAll('[data-testid="health-tile"]'),
    );
    expect(tiles.map((t) => t.getAttribute("data-kind"))).toEqual([
      "training",
      "breath",
      "night_out",
    ]);
    expect(tiles[0]?.textContent).toContain("2 of 3 sessions");
    expect(tiles[1]?.textContent).toContain("5 of 7 days");
    expect(tiles[2]?.textContent).toContain("1½ in the last 7 days");
  });

  it("shows the budget, the nights, the pace and whether it holds", async () => {
    const container = await show();
    const budget = container.querySelector('[data-testid="health-budget"]');
    expect(budget?.textContent).toContain("6");
    expect(budget?.textContent).toContain("of 12 units used");
    expect(budget?.textContent).toContain("9 nights, 2 benders");
    expect(budget?.textContent).toContain("ends at 7.7");
    expect(budget?.textContent).toContain("within the budget");
  });

  it("says when the pace is over the budget", async () => {
    fetchYear.mockResolvedValue({
      ...YEAR,
      night_out: { ...YEAR.night_out, pace: 15.2 },
    });
    const container = await show();
    expect(container.textContent).toContain("That is over the budget.");
  });

  it("lists the nights that need a home time and answers them", async () => {
    patch.mockResolvedValue({
      entry: { ...NEEDS, needs_check: false, home_at: "01:30", units: 0.5 },
    });
    const container = await show();
    const list = container.querySelector('[data-testid="health-needs-check"]');
    expect(list?.textContent).toContain("Fri 9 Oct");
    const second = list?.querySelectorAll("button")[1];
    plannerTestClick(second);
    await settle();
    expect(patch).toHaveBeenCalledWith("n9", { home_at: "01:30" });
  });

  it("leaves out the list when no night needs a time", async () => {
    fetchYear.mockResolvedValue({ ...YEAR, needs_check_entries: [] });
    const container = await show();
    expect(
      container.querySelector('[data-testid="health-needs-check"]'),
    ).toBeNull();
  });

  it("draws the year as three rows of weeks", async () => {
    const container = await show();
    const grid = container.querySelector('[data-testid="health-year-grid"]');
    const rows = grid?.querySelectorAll('[role="img"]');
    expect(rows).toHaveLength(3);
    expect(rows?.[0]?.querySelectorAll(".health-cell")).toHaveLength(53);
    // The week of 12 October holds one session and one breath day.
    const cell = rows?.[0]?.querySelector(
      '.health-cell[title^="Training, week of 12 Oct"]',
    );
    expect(cell?.getAttribute("title")).toBe(
      "Training, week of 12 Oct: 1 session",
    );
  });

  it("reads the diary again and says what it found", async () => {
    rescan.mockResolvedValue({ memos: 40, created: 3, updated: 1, removed: 0 });
    const container = await show();
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Re-read diary",
    );
    plannerTestClick(button);
    await settle();
    expect(rescan).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain(
      "Read 40 notes: 3 new, 1 changed, 0 removed.",
    );
  });

  it("says so when the diary cannot be read again", async () => {
    rescan.mockRejectedValue(new Error("offline"));
    const container = await show();
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Re-read diary",
    );
    plannerTestClick(button);
    await settle();
    expect(container.textContent).toContain(
      "Could not read the diary. Try again.",
    );
  });
});
