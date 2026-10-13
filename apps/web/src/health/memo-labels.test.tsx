// @vitest-environment jsdom
import type { HealthEntryDto } from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PlannerTestMount,
  plannerTestClick,
  plannerTestMount,
} from "@/planner/test-render";
import {
  healthDismissRequest,
  healthLoadMemoEntries,
  healthPatchEntryRequest,
} from "./api";
import { HealthMemoLabels } from "./memo-labels";
import { healthTestEntry, healthTestNight } from "./test-fixtures";

// The labels under a memo card: what shows, what the x does, and the four
// buttons that answer "home when?". The network and the toasts are replaced.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  healthLoadMemoEntries: vi.fn(),
  healthPatchEntryRequest: vi.fn(),
  healthDismissRequest: vi.fn(),
}));

const load = vi.mocked(healthLoadMemoEntries);
const patch = vi.mocked(healthPatchEntryRequest);
const dismiss = vi.mocked(healthDismissRequest);

const MEMO = {
  name: "m1",
  update_time: "2026-10-12T18:00:00.000Z",
  state: "normal" as const,
};

let mounted: PlannerTestMount | undefined;

async function show(
  entries: HealthEntryDto[],
  state: "normal" | "trashed" = "normal",
) {
  load.mockResolvedValue(entries);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  mounted = plannerTestMount(<HealthMemoLabels memo={{ ...MEMO, state }} />, {
    queryClient,
  });
  await settle();
  return mounted.container;
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
});

describe("the chips", () => {
  it("shows nothing for a memo with no labels", async () => {
    const container = await show([]);
    expect(container.querySelector('[data-testid="health-labels"]')).toBeNull();
  });

  it("shows one chip per label", async () => {
    const container = await show([
      healthTestEntry({ id: "a", variant: "back" }),
      healthTestEntry({
        id: "b",
        kind: "breath",
        variant: "wim_hof",
        minutes: 10,
      }),
    ]);
    const chips = Array.from(
      container.querySelectorAll('[data-testid="health-chip"]'),
    );
    expect(chips.map((c) => c.textContent)).toEqual([
      "Gym · Back",
      "Wim Hof · 10 min",
    ]);
  });

  it("does not ask for the labels of a memo in the trash", async () => {
    await show([healthTestEntry()], "trashed");
    expect(load).not.toHaveBeenCalled();
  });

  it("does not ask for the labels of a memo that has not reached the server", async () => {
    load.mockResolvedValue([]);
    mounted = plannerTestMount(
      <HealthMemoLabels memo={{ ...MEMO, name: "optimistic-123" }} />,
      { queryClient: new QueryClient() },
    );
    await settle();
    expect(load).not.toHaveBeenCalled();
  });

  it("removes a label with its x", async () => {
    const entry = healthTestEntry({ id: "a", variant: "legs" });
    dismiss.mockResolvedValue({ entry });
    const container = await show([entry]);
    const remove = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove label: Gym · Legs"]',
    );
    plannerTestClick(remove);
    await settle();
    expect(dismiss).toHaveBeenCalledWith("a");
    expect(container.querySelector('[data-testid="health-chip"]')).toBeNull();
  });

  it("keeps the label and says so when the removal fails", async () => {
    dismiss.mockRejectedValue(new Error("offline"));
    const container = await show([healthTestEntry({ id: "a" })]);
    plannerTestClick(container.querySelector("button[aria-label^='Remove']"));
    await settle();
    expect(toast.error).toHaveBeenCalledWith("Could not save that. Try again.");
    expect(
      container.querySelector('[data-testid="health-chip"]'),
    ).not.toBeNull();
  });
});

describe("home when?", () => {
  const night = healthTestNight({
    id: "n1",
    day: "2026-10-09",
    needs_check: true,
    units: null,
  });

  it("offers four answers for a night without a home time", async () => {
    const container = await show([night]);
    const buttons = Array.from(
      container.querySelectorAll('[data-testid="health-home-answers"] button'),
    );
    expect(buttons.map((b) => b.textContent)).toEqual([
      "Before 00:00",
      "00–03",
      "03–06",
      "Morning",
    ]);
  });

  it("does not offer them once the time is known", async () => {
    const container = await show([
      { ...night, needs_check: false, home_at: "02:00", units: 0.5 },
    ]);
    expect(
      container.querySelector('[data-testid="health-home-answers"]'),
    ).toBeNull();
  });

  it("sends the middle of the chosen window and shows the answer", async () => {
    patch.mockResolvedValue({
      entry: { ...night, needs_check: false, home_at: "04:30", units: 1 },
    });
    const container = await show([night]);
    const third = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="health-home-answers"] button',
    )[2];
    plannerTestClick(third);
    await settle();
    expect(patch).toHaveBeenCalledWith("n1", { home_at: "04:30" });
    expect(
      container.querySelector('[data-testid="health-chip"]')?.textContent,
    ).toBe("Night out · Fri · home 04:30 · 1");
    expect(
      container.querySelector('[data-testid="health-home-answers"]'),
    ).toBeNull();
  });

  it("sends 23:30, 01:30 and 08:00 for the other windows", async () => {
    patch.mockResolvedValue({ entry: night });
    const container = await show([night]);
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        '[data-testid="health-home-answers"] button',
      ),
    );
    for (const index of [0, 1, 3]) plannerTestClick(buttons[index]);
    await settle();
    expect(patch.mock.calls.map((call) => call[1])).toEqual([
      { home_at: "23:30" },
      { home_at: "01:30" },
      { home_at: "08:00" },
    ]);
  });
});
