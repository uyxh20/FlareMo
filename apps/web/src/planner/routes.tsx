import { createRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { AuthenticatedRoute } from "@/routes/authenticated-route";
import { rootRoute } from "@/routes/root-route";
import { RouteLoading } from "@/routes/route-loading";
import { plannerCockpitSearch } from "./cockpit-search";
import { plannerGoalsSearch, plannerReviewSearch } from "./goals-search";

// The planner's three pages (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md), kept out of router-tree.tsx so
// that upstream file only gains an import and one spread in the route list, like
// the health tracker's route. Each page is a lazy chunk behind the sign-in guard.
// planner-wiring.test.ts fails if a merge drops the hook-in.

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
const WeeklyReviewPage = lazy(() =>
  import("./review-page").then((module) => ({
    default: module.PlannerReviewPage,
  })),
);

function CockpitRoutePage() {
  return (
    <AuthenticatedRoute>
      <Suspense fallback={<RouteLoading />}>
        <CockpitPage />
      </Suspense>
    </AuthenticatedRoute>
  );
}

const cockpitRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/cockpit",
  // `?task=<id>` opens that task's panel (see cockpit-search.ts).
  validateSearch: plannerCockpitSearch,
  component: CockpitRoutePage,
});

function GoalsRoutePage() {
  return (
    <AuthenticatedRoute>
      <Suspense fallback={<RouteLoading />}>
        <GoalsPage />
      </Suspense>
    </AuthenticatedRoute>
  );
}

const goalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/goals",
  // The year, quarter, month or week shown (see goals-search.ts).
  validateSearch: plannerGoalsSearch,
  component: GoalsRoutePage,
});

function WeeklyReviewRoutePage() {
  return (
    <AuthenticatedRoute>
      <Suspense fallback={<RouteLoading />}>
        <WeeklyReviewPage />
      </Suspense>
    </AuthenticatedRoute>
  );
}

const weeklyReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/weekly-review",
  validateSearch: plannerReviewSearch,
  component: WeeklyReviewRoutePage,
});

export const plannerRoutes = [
  cockpitRoute,
  goalsRoute,
  weeklyReviewRoute,
] as const;
