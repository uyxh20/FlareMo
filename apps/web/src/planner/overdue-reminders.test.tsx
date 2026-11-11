// @vitest-environment jsdom
import type { PlannerOverdueResponse } from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiRequest } from "@/api/client";
import {
  PlannerOverdueReminders,
  plannerOverdueLabelFor,
} from "./overdue-reminders";
import { type PlannerTestMount, plannerTestMount } from "./test-render";

// The sidebar's task reminders: two counts from the server, both opening the
// cockpit, nothing at all when there is nothing to remind about.

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
vi.mock("@/api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/client")>()),
  apiRequest: vi.fn(),
}));

const request = vi.mocked(apiRequest);

describe("PlannerOverdueReminders", () => {
  let mount: PlannerTestMount | null = null;

  const render = async (counts: Omit<PlannerOverdueResponse, "today">) => {
    request.mockResolvedValue({ today: "2026-10-07", ...counts });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mount = plannerTestMount(<PlannerOverdueReminders />, { queryClient });
    // Let the query resolve and React render its result. A few turns of the
    // event loop, not one: under a busy parallel test run one was not enough.
    for (let turn = 0; turn < 5; turn += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    return mount.container;
  };

  beforeEach(() => {
    request.mockReset();
  });
  afterEach(() => {
    mount?.unmount();
    mount = null;
  });

  it("asks the planner API for today's counts", async () => {
    await render({ overdue: 0, due_today: 0 });
    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0]?.[0])).toMatch(
      /^\/api\/app\/planner\/overdue\?today=\d{4}-\d{2}-\d{2}$/,
    );
  });

  it("shows both lines, and both open the cockpit", async () => {
    const container = await render({ overdue: 12, due_today: 2 });
    const overdue = container.querySelector(
      '[data-testid="planner-overdue-link"]',
    );
    const today = container.querySelector(
      '[data-testid="mini-calendar-today-notice"]',
    );
    expect(overdue?.textContent).toBe("12 overdue");
    expect(overdue?.getAttribute("href")).toBe("/cockpit");
    expect(today?.textContent).toContain("2");
    expect(today?.getAttribute("href")).toBe("/cockpit");
    expect(container.querySelector('a[href="/projects"]')).toBeNull();
  });

  it("shows only the overdue line when nothing is due today", async () => {
    const container = await render({ overdue: 3, due_today: 0 });
    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(container.textContent).toBe("3 overdue");
  });

  it("renders nothing when nothing is overdue or due today", async () => {
    const container = await render({ overdue: 0, due_today: 0 });
    expect(container.innerHTML).toBe("");
  });

  it("renders nothing when the count cannot load", async () => {
    request.mockRejectedValue(new Error("offline"));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mount = plannerTestMount(<PlannerOverdueReminders />, { queryClient });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mount.container.innerHTML).toBe("");
  });
});

describe("plannerOverdueLabelFor", () => {
  it("speaks English, or Chinese for zh-CN", () => {
    expect(plannerOverdueLabelFor("en-US", 4)).toBe("4 overdue");
    expect(plannerOverdueLabelFor("fr", 1)).toBe("1 overdue");
    expect(plannerOverdueLabelFor("zh-CN", 4)).toBe("已逾期 4 件");
  });
});
