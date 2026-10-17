import { createRoute, redirect } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { AuthenticatedRoute } from "@/routes/authenticated-route";
import { rootRoute } from "@/routes/root-route";
import { RouteLoading } from "@/routes/route-loading";
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
const ReviewPage = lazy(() =>
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

function ReviewRoutePage() {
  return (
    <AuthenticatedRoute>
      <Suspense fallback={<RouteLoading />}>
        <ReviewPage />
      </Suspense>
    </AuthenticatedRoute>
  );
}

const reviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/review",
  // The chapter and Look forward's step (see goals-search.ts).
  validateSearch: plannerReviewSearch,
  component: ReviewRoutePage,
});

/** The old weekly review address: its part and step carry over. */
const weeklyReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/weekly-review",
  validateSearch: plannerReviewSearch,
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/review", search, replace: true });
  },
});

/** The old month, quarter and year review address: the date picks the chapter now. */
const periodReviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/period-review",
  beforeLoad: () => {
    throw redirect({ to: "/review", search: {}, replace: true });
  },
});

export const plannerRoutes = [
  cockpitRoute,
  goalsRoute,
  reviewRoute,
  weeklyReviewRoute,
  periodReviewRoute,
] as const;
