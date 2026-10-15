// @vitest-environment jsdom
import type { HealthWeekResponse } from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PlannerTestMount, plannerTestMount } from "@/planner/test-render";
import { healthFetchWeek } from "./api";
import { healthTestEntry, healthTestNight } from "./test-fixtures";
import { HealthWeekStrip } from "./week-strip";

// The week strip above the timeline: three rows of seven dots, a link to the
// Health page, nothing at all when it is hidden or cannot load.

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...props
  }: { to: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  healthFetchWeek: vi.fn(),
  healthFetchTrackers: vi.fn().mockResolvedValue({ trackers: [] }),
}));

const fetchWeek = vi.mocked(healthFetchWeek);

const WEEK: HealthWeekResponse = {
  start: "2026-10-07",
  end: "2026-10-13",
  today: "2026-10-13",
  entries: [
    healthTestEntry({ id: "t1", day: "2026-10-12" }),
    healthTestEntry({
      id: "b1",
      kind: "breath",
      variant: "wim_hof",
      day: "2026-10-13",
    }),
    healthTestNight({
      id: "n1",
      day: "2026-10-09",
      units: 1,
      home_at: "04:00",
    }),
    healthTestNight({
      id: "n2",
      day: "2026-10-10",
      units: null,
      needs_check: true,
    }),
  ],
  summary: {
    training: { sessions: 1, target: 3 },
    breath: { days: 1, sessions: 1, minutes: 10, target: 7 },
    night_out: {
      units: 1,
      nights: 2,
      needs_check: 1,
      year_target: 12,
      year_used: 3.5,
    },
  },
  trackers: [],
};

let mounted: PlannerTestMount | undefined;

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

function mount(visible = true) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mounted = plannerTestMount(<HealthWeekStrip visible={visible} />, {
    queryClient,
  });
  return { container: mounted.container, queryClient };
}

beforeEach(() => {
  fetchWeek.mockReset();
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe("the week strip", () => {
  it("draws three rows of seven days", async () => {
    fetchWeek.mockResolvedValue(WEEK);
    const { container } = mount();
    await settle();
    const dots = container.querySelectorAll('[data-testid="health-dot"]');
    expect(dots).toHaveLength(21);
    const state = (kind: string, day: string) =>
      container
        .querySelector(`[data-kind="${kind}"][data-day="${day}"]`)
        ?.getAttribute("data-state");
    expect(state("training", "2026-10-12")).toBe("done");
    expect(state("training", "2026-10-11")).toBe("none");
    expect(state("breath", "2026-10-13")).toBe("done");
    expect(state("night_out", "2026-10-09")).toBe("done");
    expect(state("night_out", "2026-10-10")).toBe("check");
  });

  it("counts this week, with no targets", async () => {
    fetchWeek.mockResolvedValue(WEEK);
    const { container } = mount();
    await settle();
    const counts = Array.from(container.querySelectorAll(".text-right")).map(
      (cell) => cell.textContent,
    );
    expect(counts).toEqual(["1", "1", "1"]);
    expect(container.textContent).not.toContain("/");
  });

  it("asks for this week, Monday to Sunday", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T09:00:00Z"));
    try {
      fetchWeek.mockResolvedValue(WEEK);
      mount();
      await settle();
      expect(fetchWeek).toHaveBeenCalledWith("2026-10-12");
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens the Health page", async () => {
    fetchWeek.mockResolvedValue(WEEK);
    const { container } = mount();
    await settle();
    expect(
      container
        .querySelector('[data-testid="health-week-strip"]')
        ?.getAttribute("href"),
    ).toBe("/health");
  });

  it("says in words what a ring means, for a reader without eyes", async () => {
    fetchWeek.mockResolvedValue(WEEK);
    const { container } = mount();
    await settle();
    expect(container.textContent).toContain("Home time needed");
  });

  it("does not ask for anything while hidden", async () => {
    const { container } = mount(false);
    await settle();
    expect(fetchWeek).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
  });

  it("stays out of the way when the week cannot be read", async () => {
    fetchWeek.mockRejectedValue(new Error("offline"));
    const { container } = mount();
    await settle();
    expect(container.innerHTML).toBe("");
  });

  it("reads again after the timeline saved a note", async () => {
    fetchWeek.mockResolvedValue(WEEK);
    const { queryClient } = mount();
    await settle();
    expect(fetchWeek).toHaveBeenCalledTimes(1);
    // The timeline's stats load once, then reload after a save.
    await act(async () => {
      await queryClient.fetchQuery({
        queryKey: ["memo-stats", "x"],
        queryFn: async () => 1,
      });
      await queryClient.fetchQuery({
        queryKey: ["memo-stats", "x"],
        queryFn: async () => 2,
        staleTime: 0,
      });
    });
    await settle();
    expect(fetchWeek.mock.calls.length).toBeGreaterThan(1);
  });
});
