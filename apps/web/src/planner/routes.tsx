import { createRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { AuthenticatedRoute } from "@/routes/authenticated-route";
import { rootRoute } from "@/routes/root-route";
import { RouteLoading } from "@/routes/route-loading";
import { workspaceRoute } from "@/routes/workspace-route";
import { plannerCockpitSearch } from "./cockpit-search";
import { plannerGoalsSearch, plannerReviewSearch } from "./goals-search";

// The planner's pages (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md), kept out of router-tree.tsx so
// that upstream file only gains an import and one spread in the route list, like
// the health tracker's route. Each page is a lazy chunk behind the sign-in guard.
// planner-wiring.test.ts fails if a merge drops the hook-in.
//
// /review is the one review (docs/planning-cockpit-goals-review.md and
// docs/planning-cockpit-period-review.md): the week, and the month, quarter or
// year closing with it, chosen by the date. /weekly-review and /period-review
// are its old addresses; both go to /review, so saved links keep working.

const CockpitPage = lazy(() =>
  import("./cockpit-page").then((module) => ({
    default: module.PlannerCockpitPage,
  })),
);
const GoalsPage = lazy(() =>
  import("./goals-page").then((module) => ({
    default: module.PlannerGoalsPage,
  })),
);
const MorningPage = lazy(() =>
  import("./morning-page").then((module) => ({
    default: module.PlannerMorningPage,
  })),
);
const ReviewPage = lazy(() =>
  import("./review-page").then((module) => ({
    default: module.PlannerReviewPage,
  })),
);

function CockpitRoutePage() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <CockpitPage />
    </Suspense>
  );
}

const cockpitRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/cockpit",
  // `?task=<id>` opens that task's panel (see cockpit-search.ts).
  validateSearch: plannerCockpitSearch,
  component: CockpitRoutePage,
});

function GoalsRoutePage() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <GoalsPage />
    </Suspense>
  );
}

const goalsRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/goals",
  // The year, quarter, month or week shown (see goals-search.ts).
  validateSearch: plannerGoalsSearch,
  component: GoalsRoutePage,
});

function ReviewRoutePage() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <ReviewPage />
    </Suspense>
  );
}

const reviewRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/review",
  // The chapter and Look forward's step (see goals-search.ts).
  validateSearch: plannerReviewSearch,
  component: ReviewRoutePage,
});

/** The old weekly review address: its part and step carry over. */
const weeklyReviewRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/weekly-review",
  validateSearch: plannerReviewSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/review", search, replace: true });
  },
});

/** The old month, quarter and year review address: the date picks the chapter now. */
const periodReviewRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/period-review",
  beforeLoad: () => {
    throw redirect({ to: "/review", search: {}, replace: true });
  },
});

function MorningRoutePage() {
  return (
    <AuthenticatedRoute>
      <Suspense fallback={<RouteLoading />}>
        <MorningPage />
      </Suspense>
    </AuthenticatedRoute>
  );
}

/** The morning page (docs/fork-customizations.md "Morning page"). */
const morningRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/morning",
  component: MorningRoutePage,
});

export const plannerRoutes = [
  cockpitRoute,
  goalsRoute,
  reviewRoute,
  weeklyReviewRoute,
  periodReviewRoute,
] as const;

/**
 * Pages outside the workspace shell (no sidebar): the morning page is a full
 * page of its own, so it hangs off the root route, beside the login page.
 */
export const plannerRootRoutes = [morningRoute] as const;
