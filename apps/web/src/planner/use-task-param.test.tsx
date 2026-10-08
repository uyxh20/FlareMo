// @vitest-environment jsdom
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plannerCockpitSearch } from "./cockpit-search";
import { type PlannerTestMount, plannerTestMount } from "./test-render";
import { usePlannerTaskParam } from "./use-task-param";

// Which task's panel is open lives in the address, `/cockpit?task=<id>` (fork-owned
// add-on, docs/planning-cockpit-implementation-plan.md, section 13). These run the
// hook inside a real router on an in-memory history, with the same search
// validator the app's route uses, so the rules a person feels are checked: opening
// adds an entry the back button undoes, and closing leaves no stray entry behind.

describe("plannerCockpitSearch", () => {
  it("keeps a task as a string and drops everything else", () => {
    expect(plannerCockpitSearch({ task: "abc" })).toEqual({ task: "abc" });
    expect(plannerCockpitSearch({ task: "abc", other: "x" })).toEqual({
      task: "abc",
    });
    expect(plannerCockpitSearch({})).toEqual({ task: undefined });
    expect(plannerCockpitSearch({ task: ["a", "b"] })).toEqual({
      task: undefined,
    });
    expect(plannerCockpitSearch({ task: { id: 1 } })).toEqual({
      task: undefined,
    });
  });

  it("takes the number the router makes of ?task=123 back to the id it was", () => {
    expect(plannerCockpitSearch({ task: 123 })).toEqual({ task: "123" });
  });
});

let mounted: PlannerTestMount | undefined;
beforeEach(() => {
  // The router scrolls to the top on every navigation; jsdom has no scrolling.
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
});
afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

type Param = ReturnType<typeof usePlannerTaskParam>;

/** The hook on `/cockpit`, in a router whose history starts at `entry`. */
async function show(entry: string) {
  const seen: { current: Param | undefined } = { current: undefined };
  function Probe() {
    seen.current = usePlannerTaskParam();
    return <p data-testid="task">{seen.current.taskId ?? "none"}</p>;
  }
  const rootRoute = createRootRoute();
  const cockpit = createRoute({
    getParentRoute: () => rootRoute,
    path: "/cockpit",
    validateSearch: plannerCockpitSearch,
    component: Probe,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([cockpit]),
    history: createMemoryHistory({ initialEntries: [entry] }),
  });
  await router.load();
  mounted = plannerTestMount(<RouterProvider router={router} />);
  await settle();
  return {
    router,
    param: () => seen.current as Param,
    shown: () =>
      mounted?.container.querySelector('[data-testid="task"]')?.textContent,
    href: () => router.history.location.href,
    /** Entries behind the current one, which is what the back button walks. */
    depth: () => router.history.length,
  };
}

async function settle() {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

// ---------------------------------------------------------------------------

describe("usePlannerTaskParam", () => {
  it("reports no task for a plain /cockpit", async () => {
    const { param, shown } = await show("/cockpit");
    expect(param().taskId).toBeNull();
    expect(shown()).toBe("none");
  });

  it("reads the open task from the address, as a namespaced task id", async () => {
    const { param, shown } = await show("/cockpit?task=abc-123");
    expect(param().taskId).toBe("tasks/abc-123");
    expect(shown()).toBe("tasks/abc-123");
  });

  it("does not double the namespace of an id that already has it", async () => {
    const { param } = await show("/cockpit?task=tasks%2Fabc-123");
    expect(param().taskId).toBe("tasks/abc-123");
  });

  it("treats an empty ?task= as no task", async () => {
    const { param } = await show("/cockpit?task=");
    expect(param().taskId).toBeNull();
  });

  it("opens a task by putting its bare id in the address, as a new entry", async () => {
    const { param, shown, href, depth } = await show("/cockpit");
    expect(depth()).toBe(1);
    await act(async () => {
      param().open("tasks/abc-123");
    });
    await settle();
    expect(href()).toBe("/cockpit?task=abc-123");
    expect(shown()).toBe("tasks/abc-123");
    expect(depth()).toBe(2);
  });

  it("closes a panel it opened by going back, which leaves no stray entry", async () => {
    const { param, shown, href } = await show("/cockpit");
    await act(async () => {
      param().open("tasks/abc-123");
    });
    await settle();
    await act(async () => {
      param().close();
    });
    await settle();
    expect(href()).toBe("/cockpit");
    expect(shown()).toBe("none");
  });

  it("closes a panel that was opened by loading its link by replacing the address", async () => {
    const { param, shown, href, depth } = await show("/cockpit?task=abc-123");
    expect(depth()).toBe(1);
    await act(async () => {
      param().close();
    });
    await settle();
    // Nothing to go back to: the address is rewritten in place.
    expect(href()).toBe("/cockpit");
    expect(shown()).toBe("none");
    expect(depth()).toBe(1);
  });

  it("closes a deep-linked panel by replacing even after another task was opened and closed", async () => {
    const { param, href, depth } = await show("/cockpit?task=first");
    await act(async () => {
      param().open("tasks/second");
    });
    await settle();
    expect(href()).toBe("/cockpit?task=second");
    // Closing the one this page opened goes back to the deep-linked entry...
    await act(async () => {
      param().close();
    });
    await settle();
    expect(href()).toBe("/cockpit?task=first");
    // ...and closing that one has nothing behind it, so it rewrites the address
    // (the entry count does not grow) instead of walking back off the page.
    const entries = depth();
    await act(async () => {
      param().close();
    });
    await settle();
    expect(href()).toBe("/cockpit");
    expect(depth()).toBe(entries);
  });

  it("follows the back button: it closes a panel the page opened", async () => {
    const { param, shown, router } = await show("/cockpit");
    await act(async () => {
      param().open("tasks/abc-123");
    });
    await settle();
    expect(shown()).toBe("tasks/abc-123");
    await act(async () => {
      router.history.back();
    });
    await settle();
    expect(shown()).toBe("none");
  });
});
