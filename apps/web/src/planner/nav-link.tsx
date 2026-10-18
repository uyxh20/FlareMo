import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CalendarCheck2Icon, GaugeIcon, TargetIcon } from "lucide-react";
import type { ReactNode } from "react";
import { HealthNavLink } from "@/health/nav-link"; // fork: health tracker
import { useI18n } from "@/i18n";
import { PlannerAskNavButton } from "./ask-nav";
import { plannerFetchReviewStatus } from "./goals-api";
import {
  plannerGoalsNavLabelFor,
  plannerNavLabelFor,
  plannerReviewDueLabelFor,
  plannerReviewNavLabelFor,
} from "./nav-label";
import { plannerFetchPeriodStatus } from "./period-api";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerToday } from "./use-planner-clock";

// The planner's links in the explorer sidebar (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 5, and
// docs/planning-cockpit-goals-review.md): Cockpit, Goals and Review, then
// Health and Ask my diary (docs/fork-general-agent.md). They
// live here so the explorer's edit stays an import plus one element, and they are
// styled exactly like the explorer's other page links. The cockpit's icon is a
// gauge, distinct from the folder board of /projects and /team-projects beside
// it. The labels are the pages' own copy (the pages read them from the same
// place), kept in a tiny module so these links, which load with every page, do
// not pull in the pages' whole dictionaries.
//
// The review's link carries a dot from Saturday to Monday until the week's two
// parts are done (`GET /review/status`) and, when a month, quarter or year
// closes with the reviewed week, until its chapter is saved too
// (`GET /period-review/status`, docs/planning-cockpit-period-review.md).

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
  to: "/cockpit" | "/goals" | "/review";
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

/** Whether a month, quarter or year review closes with this week and is not done. */
function usePeriodDue(): boolean {
  const today = usePlannerToday();
  const status = useQuery({
    queryKey: plannerQueryKeys.periodStatus(today),
    queryFn: () => plannerFetchPeriodStatus(today),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    retry: false,
  });
  return status.data?.any_due ?? false;
}

export function PlannerNavLink({ onNavigate }: { onNavigate?: () => void }) {
  const { locale } = useI18n();
  const due = useReviewDue();
  const periodDue = usePeriodDue();
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
        to="/review"
        onNavigate={onNavigate}
      >
        {(due || periodDue) && (
          <span
            className="size-2 shrink-0 rounded-full bg-brand-500 dark:bg-brand-400"
            data-testid="planner-review-due"
          >
            <span className="sr-only">{plannerReviewDueLabelFor(locale)}</span>
          </span>
        )}
      </PlannerLink>
      <HealthNavLink onNavigate={onNavigate} /> {/* fork: health tracker */}
      <PlannerAskNavButton onNavigate={onNavigate} />
    </>
  );
}
