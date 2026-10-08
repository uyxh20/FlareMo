import { useNavigate, useRouter, useSearch } from "@tanstack/react-router";
import { useCallback, useRef } from "react";
import { plannerTaskIdFromParam, plannerTaskParamFromId } from "./panel-model";

// Which task's panel is open, kept in the address as `/cockpit?task=<id>`
// (fork-owned add-on, docs/planning-cockpit-implementation-plan.md, section 13).
// The address is the truth, so the panel can be linked to and reloaded, and the
// browser's back button closes it.
//
// Opening a panel adds a history entry. Closing it from the page (the sheet's
// close button, Esc, a click outside) goes back one entry when this page made that
// entry, which leaves no stray `/cockpit?task=` behind the back button; for a
// panel that was opened by loading the link, there is nothing to go back to, so
// the address is replaced instead.

export function usePlannerTaskParam(): {
  /** The open task (`tasks/<id>`), or null. */
  taskId: string | null;
  open: (taskId: string) => void;
  close: () => void;
} {
  const search = useSearch({ from: "/cockpit" });
  const navigate = useNavigate({ from: "/cockpit" });
  const router = useRouter();
  // Whether the current entry was added by `open` in this page.
  const pushed = useRef(false);

  const open = useCallback(
    (taskId: string) => {
      pushed.current = true;
      void navigate({ search: { task: plannerTaskParamFromId(taskId) } });
    },
    [navigate],
  );

  const close = useCallback(() => {
    if (pushed.current) {
      pushed.current = false;
      router.history.back();
      return;
    }
    void navigate({ search: { task: undefined }, replace: true });
  }, [navigate, router]);

  return { taskId: plannerTaskIdFromParam(search.task), open, close };
}
