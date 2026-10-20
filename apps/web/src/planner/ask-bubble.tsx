import { useQuery } from "@tanstack/react-query";
import { MessageCircleIcon, XIcon } from "lucide-react";
import { lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/i18n";
import { plannerFetchAsk } from "./ask-api";
import { plannerSetAsk, usePlannerAsk, usePlannerAskHost } from "./ask-store";
import { plannerAskNavLabelFor } from "./nav-label";
import { plannerQueryKeys } from "./query-keys";
import { usePlannerToday } from "./use-planner-clock";

// Ask my diary's chat bubble (fork-owned add-on, docs/fork-general-agent.md):
// a round button in the bottom-right corner of every page that opens the chat
// window just above it. It shows only where the general agent is set up. The
// window's code loads the first time it opens. The page layouts mount it
// (App.tsx and workspace-layout.tsx, one line each); one mounted bubble draws.

const AskWindow = lazy(() =>
  import("./ask-window").then((module) => ({
    default: module.PlannerAskWindow,
  })),
);

export function PlannerAskBubble() {
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
  if (!host || !status.data?.enabled || typeof document === "undefined") {
    return null;
  }
  const label = plannerAskNavLabelFor(locale);
  return createPortal(
    <>
      {ask.open && (
        <Suspense fallback={null}>
          <AskWindow />
        </Suspense>
      )}
      <button
        aria-expanded={ask.open}
        aria-label={label}
        className="fixed right-4 bottom-4 z-50 flex size-12 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-95 motion-safe:transition-transform sm:right-6 sm:bottom-6"
        data-testid="planner-ask-button"
        title={label}
        type="button"
        onClick={() => plannerSetAsk({ open: !ask.open })}
      >
        {ask.open ? (
          <XIcon className="size-5" />
        ) : (
          <MessageCircleIcon className="size-5" />
        )}
      </button>
    </>,
    document.body,
  );
}
