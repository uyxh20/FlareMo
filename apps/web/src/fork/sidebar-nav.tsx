import { Children, type ComponentProps, isValidElement } from "react";

// Fork-owned (docs/fork-customizations.md). The owner does not use Team
// projects, Projects or Articles, so their sidebar links are hidden. The routes
// keep working by URL; the search, the notification bell, the overdue link in
// the mini calendar and the cockpit link are untouched.
//
// flaremo-explorer.tsx keeps every <Link> block and only swaps its <nav> for
// ForkSidebarNav, which drops the links listed here. That keeps the upstream
// diff to three lines, and an upstream edit to one of those links still merges.

/**
 * Sidebar routes this fork does not show. To bring one back, delete its line;
 * nothing else needs to change. (The links are filtered by their `to` prop, so
 * this list and the `to="…"` in flaremo-explorer.tsx must spell the route the
 * same way. The wiring test fails when they drift apart.)
 */
export const forkHiddenSidebarRoutes = [
  "/team-projects",
  "/projects",
  "/articles",
] as const satisfies readonly string[];

const hiddenRoutes: ReadonlySet<string> = new Set<string>(
  forkHiddenSidebarRoutes,
);

/**
 * Drop-in for `<nav>`: every prop is forwarded, and so is every child except an
 * element whose `to` prop is a hidden route. Conditional children (`{cond &&
 * <Link/>}` renders nothing when false) and other components (the cockpit
 * link) have no such `to`, so they pass through untouched.
 */
export function ForkSidebarNav({ children, ...props }: ComponentProps<"nav">) {
  const visible = Children.toArray(children).filter((child) => {
    if (!isValidElement<{ to?: unknown }>(child)) return true;
    const { to } = child.props;
    return typeof to !== "string" || !hiddenRoutes.has(to);
  });
  return <nav {...props}>{visible}</nav>;
}
