// @vitest-environment jsdom
import type { HealthGoalProgress } from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type PlannerTestMount, plannerTestMount } from "@/planner/test-render";
import { healthFetchGoalProgress } from "./api";
import { HealthGoalProgressLines } from "./goal-progress";
import { healthGoalProgressText } from "./model";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  healthFetchGoalProgress: vi.fn(),
}));

const FASTING: HealthGoalProgress = {
  goal_id: "goal-q4",
  level: "quarter",
  kind: "t:fast00000001",
  label: "Fasting",
  color: "green",
  measure: "hours",
  from: "2026-10-01",
  to: "2026-12-31",
  days: 9,
  minutes: 9 * 16 * 60 + 60,
  timed_days: 8,
};

let mounted: PlannerTestMount | undefined;
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe("a tracker on its goal's card", () => {
  it("says the days so far and the average length", () => {
    expect(healthGoalProgressText(FASTING)).toBe(
      "Fasting · 9 days so far · avg 18.1 h",
    );
    expect(
      healthGoalProgressText({ ...FASTING, measure: "days", days: 1 }),
    ).toBe("Fasting · 1 day so far");
    expect(
      healthGoalProgressText({
        ...FASTING,
        measure: "minutes",
        minutes: 50,
        timed_days: 5,
      }),
    ).toBe("Fasting · 9 days so far · avg 10 min");
  });

  it("shows only the lines of its own goal", async () => {
    vi.mocked(healthFetchGoalProgress).mockResolvedValue({
      progress: [FASTING, { ...FASTING, goal_id: "other", label: "Cold" }],
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mounted = plannerTestMount(
      <div>
        <HealthGoalProgressLines goalId="goal-q4" />
        <HealthGoalProgressLines goalId="none" />
      </div>,
      { queryClient },
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const lines = mounted.container.querySelectorAll(
      '[data-testid="health-goal-progress"]',
    );
    expect(Array.from(lines, (line) => line.textContent)).toEqual([
      "Fasting · 9 days so far · avg 18.1 h",
    ]);
    expect(lines[0]?.className).toContain("health-kind-t-green");
  });
});
