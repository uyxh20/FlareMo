import { createRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { RouteLoading } from "@/routes/route-loading";
import { workspaceRoute } from "@/routes/workspace-route";

// The /memory route (fork-owned, docs/fork-customizations.md). Upstream removed
// the Memory page in v0.27; the fork keeps it, so its route lives here and
// router-tree.tsx only gains an import and one entry, like /health.

const MemoryPage = lazy(() =>
  import("./memory-page").then((module) => ({ default: module.MemoryPage })),
);

function MemoryRoutePage() {
  return (
    <Suspense fallback={<RouteLoading />}>
      <MemoryPage />
    </Suspense>
  );
}

export const forkMemoryRoute = createRoute({
  getParentRoute: () => workspaceRoute,
  path: "/memory",
  component: MemoryRoutePage,
});
