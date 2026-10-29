import { useEffect, useId, useSyncExternalStore } from "react";

// The Ask window's own state (fork-owned add-on, docs/fork-general-agent.md),
// outside React: every page mounts its own layout and so its own bubble, while
// the window and what is typed in it stay put. Exactly one mounted bubble
// draws: the first one.

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
// How many task agent drawers are open: the bubble steps aside for them.
let held = 0;
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

/**
 * Keeps the bubble out of the way while the caller is mounted: a task's own
 * agent drawer (task-agent.tsx) has its own question box where the bubble
 * would sit.
 */
export function usePlannerAskHold(): void {
  useEffect(() => {
    held += 1;
    emit();
    return () => {
      held -= 1;
      emit();
    };
  }, []);
}

/** True while something asked the bubble to step aside. */
export function usePlannerAskHeld(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => held > 0,
    () => false,
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
