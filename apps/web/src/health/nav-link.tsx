import { Link } from "@tanstack/react-router";
import { HeartPulseIcon } from "lucide-react";
import { NAV_ACTIVE_CLASS, NAV_ITEM_CLASS } from "@/components/nav-item-styles";
import { healthStrings } from "./strings";

// The Health link in the explorer sidebar (fork-owned add-on,
// docs/fork-health-tracker.md). It is rendered by PlannerNavLink, right after
// the planner's own links, so the explorer's file stays untouched. Styled with
// the explorer's shared row style, like every other sidebar link.

export function HealthNavLink({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      activeProps={{ className: NAV_ACTIVE_CLASS }}
      className={NAV_ITEM_CLASS}
      onClick={onNavigate}
      to="/health"
    >
      <HeartPulseIcon />
      <span className="min-w-0 flex-1 truncate">{healthStrings.nav}</span>
    </Link>
  );
}
