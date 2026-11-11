import { createRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { RouteLoading } from "@/routes/route-loading";
import { workspaceRoute } from "@/routes/workspace-route";

// The /health route (fork-owned add-on, docs/fork-health-tracker.md), kept out of
// router-tree.tsx so that file only gains an import and one entry in the route
// list. The page is a lazy chunk, like the planner's pages.

const HealthPage = lazy(() =>
  import("./health-page").then((module) => ({ default: module.HealthPage })),
);

function HealthRoutePage() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <HealthPage />
    </Suspense>
  );
}

export const healthRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/health",
  component: HealthRoutePage,
});
