// @vitest-environment jsdom
import type { HealthWeekResponse } from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type PlannerTestMount, plannerTestMount } from "@/planner/test-render";
import { healthFetchWeek } from "./api";
import { healthTestEntry, healthTestNight } from "./test-fixtures";
import { HealthWeekStrip } from "./week-strip";

// The week strip above the timeline: one row of seven dots per family
// (Fitness, Breath, Out, own trackers), a way to the Health page, a pop-up of
// sub-types behind each name, nothing at all when it is hidden or cannot load.

const navigate = vi.fn();
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigate,
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
  it("draws the four families: Fitness, Breath and Out", async () => {
    fetchWeek.mockResolvedValue(WEEK);
    const { container } = mount();
    await settle();
    const names = Array.from(
      container.querySelectorAll('[data-testid="health-row-name"]'),
    ).map((name) => name.textContent);
    expect(names).toEqual(["Fitness", "Breath", "Out"]);
    const dots = container.querySelectorAll('[data-testid="health-dot"]');
    expect(dots).toHaveLength(21);
    const state = (kind: string, day: string) =>
      container
        .querySelector(`[data-kind="${kind}"][data-day="${day}"]`)
        ?.getAttribute("data-state");
    expect(state("training+wellness", "2026-10-12")).toBe("done");
    expect(state("training+wellness", "2026-10-11")).toBe("none");
    expect(state("breath", "2026-10-13")).toBe("done");
    expect(state("night_out", "2026-10-09")).toBe("done");
    expect(state("night_out", "2026-10-10")).toBe("check");
  });

  it("names the sub-type on a dot", async () => {
    fetchWeek.mockResolvedValue(WEEK);
    const { container } = mount();
    await settle();
    const title = (kind: string, day: string) =>
      container
        .querySelector(`[data-kind="${kind}"][data-day="${day}"]`)
        ?.getAttribute("title");
    expect(title("training+wellness", "2026-10-12")).toBe("Mon · Gym");
    expect(title("breath", "2026-10-13")).toBe("Tue · Wim Hof");
    expect(title("night_out", "2026-10-09")).toBe(
      "Fri · Big night · home 04:00",
    );
  });

  it("counts this week, with no targets", async () => {
    fetchWeek.mockResolvedValue(WEEK);
    const { container } = mount();
    await settle();
    const counts = Array.from(container.querySelectorAll(".text-right")).map(
      (cell) => cell.textContent,
    );
    // Days (nights) with a row of each family.
    expect(counts).toEqual(["1", "1", "2"]);
    expect(container.textContent).not.toContain("/");
  });

  it("counts a gym session and a sauna on one day as two", async () => {
    fetchWeek.mockResolvedValue({
      ...WEEK,
      entries: [
        ...WEEK.entries,
        healthTestEntry({
          id: "w1",
          kind: "wellness",
          variant: "sauna",
          day: "2026-10-12",
        }),
      ],
    });
    const { container } = mount();
    await settle();
    const counts = Array.from(container.querySelectorAll(".text-right")).map(
      (cell) => cell.textContent,
    );
    // Fitness counts sessions; Out still counts nights.
    expect(counts).toEqual(["2", "1", "2"]);
  });

  it("opens a family's sub-types, and not the Health page", async () => {
    fetchWeek.mockResolvedValue(WEEK);
    const { container } = mount();
    await settle();
    navigate.mockReset();
    const fitness = container.querySelector<HTMLButtonElement>(
      '[data-testid="health-row-name"][data-family="fitness"]',
    );
    await act(async () => fitness?.click());
    await settle();
    const dialog = document.querySelector('[data-testid="health-breakdown"]');
    expect(dialog?.textContent).toContain("Fitness this week");
    expect(dialog?.textContent).toContain("Gym");
    expect(navigate).not.toHaveBeenCalled();
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
    navigate.mockReset();
    await act(async () =>
      container
        .querySelector<HTMLElement>('[data-testid="health-week-strip"]')
        ?.click(),
    );
    expect(navigate).toHaveBeenCalledWith({ to: "/health" });
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
