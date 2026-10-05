import { Link } from "@tanstack/react-router";
import { GaugeIcon } from "lucide-react";
import { useI18n } from "@/i18n";
import { plannerNavLabelFor } from "./nav-label";

// The cockpit's link in the explorer sidebar (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5). It lives here so the
// explorer's edit is an import plus one element, and it is styled exactly like
// the explorer's other page links. The icon is a gauge, distinct from the folder
// board of /projects and /team-projects beside it. The label is the cockpit's own
// copy (strings.ts reads it from the same place), kept in a tiny module so this
// link, which loads with every page, does not pull in the page's whole dictionary.

export function PlannerNavLink({ onNavigate }: { onNavigate?: () => void }) {
  const { locale } = useI18n();
  return (
    <Link
      activeProps={{
        className: "!bg-accent !text-accent-foreground font-medium",
      }}
      className="flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5"
      onClick={onNavigate}
      to="/cockpit"
    >
      <GaugeIcon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">
        {plannerNavLabelFor(locale)}
      </span>
    </Link>
  );
}
