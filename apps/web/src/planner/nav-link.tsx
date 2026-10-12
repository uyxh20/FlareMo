import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarCheck2Icon, GaugeIcon, TargetIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useI18n } from "@/i18n";
import { plannerFetchReviewStatus } from "./goals-api";
import {
  plannerGoalsNavLabelFor,
  plannerNavLabelFor,
  plannerReviewDueLabelFor,
  plannerReviewNavLabelFor,
} from "./nav-label";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerToday } from "./use-planner-clock";

// The planner's links in the explorer sidebar (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5, and
// docs/planning-cockpit-goals-review.md): Cockpit, Goals and Weekly review. They
// live here so the explorer's edit stays an import plus one element, and they are
// styled exactly like the explorer's other page links. The cockpit's icon is a
// gauge, distinct from the folder board of /projects and /team-projects beside
// it. The labels are the pages' own copy (the pages read them from the same
// place), kept in a tiny module so these links, which load with every page, do
// not pull in the pages' whole dictionaries.
//
// The weekly review's link carries a dot from Saturday to Monday until both parts
// of the review are done (`GET /review/status`).

const LINK_CLASS =
  "flex h-9 items-center gap-3 rounded-lg px-2.5 text-muted-foreground motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground motion-safe:hover:translate-x-0.5";

const ACTIVE = {
  className: "!bg-accent !text-accent-foreground font-medium",
};

function PlannerLink({
  to,
  icon,
  label,
  onNavigate,
  children,
}: {
  to: "/cockpit" | "/goals" | "/weekly-review";
  icon: ReactNode;
  label: string;
  onNavigate?: () => void;
  children?: ReactNode;
}) {
  return (
    <Link
      activeProps={ACTIVE}
      className={LINK_CLASS}
      onClick={onNavigate}
      to={to}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {children}
    </Link>
  );
}

/** Whether a weekly review is due today; false while unknown or on a failed read. */
function useReviewDue(): boolean {
  const today = usePlannerToday();
  const status = useQuery({
    queryKey: plannerQueryKeys.reviewStatus(today),
    queryFn: () => plannerFetchReviewStatus(today),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return status.data?.due ?? false;
}

export function PlannerNavLink({ onNavigate }: { onNavigate?: () => void }) {
  const { locale } = useI18n();
  const due = useReviewDue();
  return (
    <>
      <PlannerLink
        icon={<GaugeIcon className="size-4 shrink-0" />}
        label={plannerNavLabelFor(locale)}
        to="/cockpit"
        onNavigate={onNavigate}
      />
      <PlannerLink
        icon={<TargetIcon className="size-4 shrink-0" />}
        label={plannerGoalsNavLabelFor(locale)}
        to="/goals"
        onNavigate={onNavigate}
      />
      <PlannerLink
        icon={<CalendarCheck2Icon className="size-4 shrink-0" />}
        label={plannerReviewNavLabelFor(locale)}
        to="/weekly-review"
        onNavigate={onNavigate}
      >
        {due && (
          <span
            className="size-2 shrink-0 rounded-full bg-brand-500 dark:bg-brand-400"
            data-testid="planner-review-due"
          >
            <span className="sr-only">{plannerReviewDueLabelFor(locale)}</span>
          </span>
        )}
      </PlannerLink>
    </>
  );
}
