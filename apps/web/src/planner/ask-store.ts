import { useEffect, useId, useSyncExternalStore } from "react";

// The Ask window's own state (fork-owned add-on, docs/fork-general-agent.md),
// outside React: the sidebar mounts again on every page and the mobile drawer
// mounts a second one, while the window and what is typed in it stay put.
// Exactly one mounted sidebar button hosts the window: the first one, which on
// a wide screen is the sidebar that is always there.

export type PlannerAskState = {
  open: boolean;
  /** The conversation shown; null for the latest one. */
  conversation: string | null;
  /** A new chat with no question asked yet. */
  fresh: boolean;
  draft: string;
};

let state: PlannerAskState = {
  open: false,
  conversation: null,
  fresh: false,
  draft: "",
};
let hosts: string[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function plannerSetAsk(patch: Partial<PlannerAskState>) {
  state = { ...state, ...patch };
  emit();
}

export function usePlannerAsk(): PlannerAskState {
  return useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
}

/** True for the one mounted button that draws the window. */
export function usePlannerAskHost(): boolean {
  const id = useId();
  useEffect(() => {
    hosts = [...hosts, id];
    emit();
    return () => {
      hosts = hosts.filter((host) => host !== id);
      emit();
    };
  }, [id]);
  return useSyncExternalStore(
    subscribe,
    () => hosts[0] === id,
    () => false,
  );
}
