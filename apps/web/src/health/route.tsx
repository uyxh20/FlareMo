import { createRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { AuthenticatedRoute } from "@/routes/authenticated-route";
import { rootRoute } from "@/routes/root-route";
import { RouteLoading } from "@/routes/route-loading";

// The /health route (fork-owned add-on, docs/fork-health-tracker.md), kept out of
// router-tree.tsx so that file only gains an import and one entry in the route
// list. The page is a lazy chunk, like the planner's pages.

const HealthPage = lazy(() =>
  import("./health-page").then((module) => ({ default: module.HealthPage })),
);

function HealthRoutePage() {
  return (
    <AuthenticatedRoute>
      <Suspense fallback={<RouteLoading />}>
        <HealthPage />
      </Suspense>
    </AuthenticatedRoute>
  );
}

export const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/health",
  component: HealthRoutePage,
});
