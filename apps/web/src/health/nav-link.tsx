import { Link } from "@tanstack/react-router";
import { HeartPulseIcon } from "lucide-react";
import { healthStrings } from "./strings";

// The Health link in the explorer sidebar (fork-owned add-on,
// docs/fork-health-tracker.md). It is rendered by PlannerNavLink, right after
// the planner's own links, so the explorer's file stays untouched. Styled like
// the planner links beside it.

const LINK_CLASS =
  "flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5";

export function HealthNavLink({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      activeProps={{
        className: "!bg-accent !text-accent-foreground font-medium",
      }}
      className={LINK_CLASS}
      onClick={onNavigate}
      to="/health"
    >
      <HeartPulseIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{healthStrings.nav}</span>
    </Link>
  );
}
