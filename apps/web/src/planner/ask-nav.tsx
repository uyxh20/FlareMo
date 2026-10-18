import { useQuery } from "@tanstack/react-query";
import { MessageCircleIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n";
import { cn } from "@/lib/utils";
import { plannerFetchAsk } from "./ask-api";
import { plannerSetAsk, usePlannerAsk, usePlannerAskHost } from "./ask-store";
import { plannerAskNavLabelFor } from "./nav-label";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerToday } from "./use-planner-clock";

// Ask my diary's place in the sidebar (fork-owned add-on,
// docs/fork-general-agent.md): a button under the planner's links that opens
// the chat window over the page. It shows only where the general agent is set
// up. The window's code loads the first time it opens.

const AskWindow = lazy(() =>
  import("./ask-window").then((module) => ({
    default: module.PlannerAskWindow,
  })),
);

const LINK_CLASS =
  "flex h-9 w-full cursor-pointer items-center gap-3 rounded-lg px-2.5 text-muted-foreground outline-none motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 motion-safe:hover:translate-x-0.5";

export function PlannerAskNavButton({
  onNavigate,
}: {
  onNavigate?: () => void;
}) {
  const { locale } = useI18n();
  const today = usePlannerToday();
  const ask = usePlannerAsk();
  const host = usePlannerAskHost();
  const status = useQuery({
    queryKey: plannerQueryKeys.ask(null),
    queryFn: () => plannerFetchAsk(today, null),
    staleTime: 5 * 60_000,
    retry: false,
  });
  if (!status.data?.enabled) return null;
  return (
    <>
      <button
        aria-expanded={ask.open}
        className={cn(
          LINK_CLASS,
          ask.open && "bg-accent font-medium text-accent-foreground",
        )}
        data-testid="planner-ask-button"
        type="button"
        onClick={() => {
          plannerSetAsk({ open: !ask.open });
          // On a phone the drawer closes so the window is in view.
          if (!ask.open) onNavigate?.();
        }}
      >
        <MessageCircleIcon className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">
          {plannerAskNavLabelFor(locale)}
        </span>
      </button>
      {host &&
        ask.open &&
        typeof document !== "undefined" &&
        createPortal(
          <Suspense fallback={null}>
            <AskWindow />
          </Suspense>,
          document.body,
        )}
    </>
  );
}
