import { useEffect, useRef, useState } from "react";

// Saving text as it is typed (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): the task panel's
// notes. The text is saved about 800 ms after typing stops, though never sooner
// than 5 s after the previous save began; at once when the field loses focus; at
// once when the page is hidden or closed; and once more when the panel goes away
// with something unsaved, so closing the panel never loses a sentence.
//
// The 5 s gap caps typing at about 12 saves a minute. Every save is a write in the
// `planner` rate-limit bucket, which allows 30 a minute per user (wrangler.json)
// and which moves, plans and comments share, so a long stretch of typing has to
// leave room for them.
//
// What the gap costs is text waiting for it when the page goes away. The hook
// saves it at once when the page is hidden (`visibilitychange` to "hidden": a tab
// or app switch, and most tab closes) and on `pagehide`, ignoring the gap, as a
// request marked `keepalive`, which asks the browser to finish it even if the page
// is gone (see `plannerUpdateTaskRequest` in api.ts for the size that is limited
// to; a bigger body goes as an ordinary request). Coming back to the page does
// nothing.
//
// That is best effort, and it works best where the page stays alive: on a tab or
// app switch the save simply completes. When the page is being navigated away or
// closed the browser may still drop the request. Observed in headless Chromium: a
// save started during a real navigation was lost, with or without `keepalive`,
// while the app's service worker controlled the page, and it arrived with service
// workers blocked. So text typed in the last few seconds before a close can still
// be lost, along with whatever a crash takes.
//
// The rules are a small state machine, written without React so they can be
// tested with fake timers:
//
// - A value that is the same as the saved one, once trimmed (the server trims
//   notes, so a trailing space is not a change), is never sent.
// - Two saves never overlap. Typing during a save sends exactly one more save,
//   with the newest text, when the first has finished (and the gap allows it).
// - Saves the typing timer starts are at least `minGapMs` apart, counted from the
//   start of the previous save, whoever started that one. A pause that ends inside
//   the gap is re-armed for what is left of it, so the text waits and is never
//   dropped. A blur, Enter, `retry()`, `dispose()` and the page being hidden or
//   closed (`flushOnHide()`) ignore the gap: they are the person saying "now", or
//   the page going away, and there are few of them. Only the last is told to send
//   its save so that it outlives the page.
// - A failed save keeps what was typed (never rolled back: that would throw the
//   person's words away), says so, and is retried by the next edit (after the
//   gap), the next blur or `retry()`.
// - The server's own value is adopted (`reset`) only while nothing here is
//   unsaved, so an edit made elsewhere shows up without clobbering typing.

export type PlannerAutosaveStatus =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "error";

export type PlannerAutosaveState = {
  /** What the field shows. */
  value: string;
  status: PlannerAutosaveStatus;
};

/** The pause after the last key before the text is saved. */
export const plannerAutosaveDelayMs = 800;

/**
 * The least time from the start of one save to the start of the next one the
 * typing timer makes: 5 s, which is at most 12 saves in a minute.
 */
export const plannerAutosaveMinGapMs = 5000;

type Timers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
};

/** What `save` is told about the save it is asked to make. */
export type PlannerAutosaveSaveContext = {
  /**
   * True when the save was started because the page is being hidden or closed:
   * send it so that it outlives the page (fetch's `keepalive`).
   */
  keepalive: boolean;
};

export type PlannerAutosave = {
  getState: () => PlannerAutosaveState;
  /** The field's text changed. */
  change: (value: string) => void;
  /** Save now, if there is anything to save (a blur, or Enter). */
  flush: () => void;
  /**
   * The page is being hidden or closed: save now, if there is anything to save,
   * and ask for the save to outlive the page. Ignores the gap, like `flush`.
   */
  flushOnHide: () => void;
  /** Try again after a failure. */
  retry: () => void;
  /** The server's value changed: adopt it when nothing here is unsaved. */
  reset: (saved: string) => void;
  /** The panel is going away: save what is left. */
  dispose: () => void;
};

export function createPlannerAutosave(options: {
  /** What the server has now. */
  saved: string;
  /** Saves one value; rejects when it could not be saved. */
  save: (value: string, context: PlannerAutosaveSaveContext) => Promise<void>;
  delayMs?: number;
  /**
   * The least time from the start of one save to the start of the next one the
   * typing timer makes; 0 turns the limit off. A blur, Enter, `retry()`,
   * `dispose()` and `flushOnHide()` ignore it.
   */
  minGapMs?: number;
  /** Whether two texts are the same for saving; default: equal once trimmed. */
  same?: (left: string, right: string) => boolean;
  onState?: (state: PlannerAutosaveState) => void;
  timers?: Timers;
  /** The clock the gap is measured with, in milliseconds; default `Date.now`. */
  now?: () => number;
}): PlannerAutosave {
  const delayMs = options.delayMs ?? plannerAutosaveDelayMs;
  const minGapMs = Math.max(0, options.minGapMs ?? plannerAutosaveMinGapMs);
  const same = options.same ?? ((left, right) => left.trim() === right.trim());
  const timers: Timers = options.timers ?? {
    set: (callback, ms) => setTimeout(callback, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const now = options.now ?? (() => Date.now());

  let value = options.saved;
  let saved = options.saved;
  let status: PlannerAutosaveStatus = "idle";
  let timer: unknown;
  let hasTimer = false;
  let inFlight = false;
  // A flush that arrived while a save was in flight: run it when that one ends.
  let queued = false;
  // Whether one of the flushes queued meanwhile came from the page going away: the
  // save they run asks to outlive it.
  let queuedKeepalive = false;
  // When the previous save began, whoever began it; null until the first one.
  let lastStartedAt: number | null = null;

  const publish = () => options.onState?.({ value, status });
  const setStatus = (next: PlannerAutosaveStatus) => {
    status = next;
    publish();
  };
  const stopTimer = () => {
    if (hasTimer) timers.clear(timer);
    hasTimer = false;
  };
  const armTimer = (ms: number) => {
    stopTimer();
    hasTimer = true;
    timer = timers.set(onPause, ms);
  };
  const startTimer = () => armTimer(delayMs);

  /**
   * The pause after the last key has run out: save, unless that would start a
   * save too soon after the previous one, in which case wait for the rest of the
   * gap. The text is not dropped, only held: the next key or the end of the gap
   * brings the timer round again.
   */
  function onPause() {
    hasTimer = false;
    if (lastStartedAt !== null && minGapMs > 0) {
      const sinceLast = now() - lastStartedAt;
      // A clock that was set back reads as a negative time since the last save.
      // The gap cannot be measured then, so it counts as over rather than
      // holding the text until the clock catches up.
      const left = sinceLast < 0 ? 0 : minGapMs - sinceLast;
      if (left > 0) {
        armTimer(left);
        return;
      }
    }
    flush(false);
  }

  /**
   * Save now, ignoring the gap. `keepalive` says the save is being made because
   * the page is going away. It is a parameter of this internal function, not of the
   * `flush` that is handed out, which a field's onBlur calls with its event.
   */
  function flush(keepalive: boolean) {
    stopTimer();
    if (inFlight) {
      queued = true;
      queuedKeepalive = queuedKeepalive || keepalive;
      return;
    }
    if (same(value, saved)) return;
    void run(keepalive);
  }

  async function run(keepalive: boolean) {
    inFlight = true;
    queued = false;
    queuedKeepalive = false;
    lastStartedAt = now();
    const sending = value;
    setStatus("saving");
    let ok = true;
    try {
      await options.save(sending, { keepalive });
    } catch {
      ok = false;
    }
    inFlight = false;
    if (!ok) {
      queued = false;
      queuedKeepalive = false;
      setStatus("error");
      return;
    }
    saved = sending;
    if (same(value, saved)) {
      queued = false;
      queuedKeepalive = false;
      setStatus("saved");
    } else if (queued) {
      // Typing went on during the save, and a flush came meanwhile (the pause ran
      // out past the gap, or a blur, or the page going away): send the rest now.
      flush(queuedKeepalive);
    } else {
      // Typing went on and its timer is still running: it will send the rest.
      setStatus("dirty");
    }
  }

  return {
    getState: () => ({ value, status }),

    change(next) {
      value = next;
      if (same(value, saved) && !inFlight) {
        stopTimer();
        // Typed back to what is saved: nothing is waiting to be sent.
        setStatus("idle");
        return;
      }
      if (inFlight) {
        publish();
      } else {
        setStatus("dirty");
      }
      startTimer();
    },

    flush: () => flush(false),

    flushOnHide: () => flush(true),

    retry: () => flush(false),

    reset(next) {
      saved = next;
      if (status === "dirty" || status === "saving" || status === "error") {
        return;
      }
      // Only a real difference replaces the text: the server trims notes, so
      // adopting "hello" for "hello " would eat the space someone just typed.
      if (!same(value, next)) {
        value = next;
        publish();
      }
    },

    dispose() {
      stopTimer();
      if (same(value, saved)) return;
      if (inFlight) {
        // The save in flight does not have the latest text: send it after.
        queued = true;
      } else {
        void run(false);
      }
    },
  };
}

/**
 * `createPlannerAutosave` for a text field: `value` for the textarea, `onChange`
 * and `onBlur` to hand it, and the status for the "Saved" line. One controller
 * lives as long as the component (give it a `key` per task), saves what is left
 * when the component goes away or the page is hidden or closed, and follows
 * `saved` when the server's value moves.
 */
export function usePlannerAutosave(options: {
  saved: string;
  save: (value: string, context: PlannerAutosaveSaveContext) => Promise<void>;
  delayMs?: number;
  minGapMs?: number;
}) {
  const [state, setState] = useState<PlannerAutosaveState>({
    value: options.saved,
    status: "idle",
  });
  const saveRef = useRef(options.save);
  saveRef.current = options.save;

  // One controller per mount, made on the first render; later `saved` values
  // arrive through `reset`, and `delayMs` and `minGapMs` are read once.
  const controllerRef = useRef<PlannerAutosave | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = createPlannerAutosave({
      saved: options.saved,
      save: (value, context) => saveRef.current(value, context),
      delayMs: options.delayMs,
      minGapMs: options.minGapMs,
      onState: setState,
    });
  }
  const controller = controllerRef.current;

  useEffect(() => {
    controller.reset(options.saved);
  }, [controller, options.saved]);
  useEffect(() => () => controller.dispose(), [controller]);

  // The page going away: hidden (switching tab or app, and most tab closes, which
  // hide the page first) or `pagehide` (the rest, and leaving the page). Save what
  // is unsaved at once, as a request that outlives the page. Becoming visible again
  // does nothing.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") controller.flushOnHide();
    };
    const onPageHide = () => controller.flushOnHide();
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [controller]);

  return {
    value: state.value,
    status: state.status,
    onChange: controller.change,
    onBlur: controller.flush,
    retry: controller.retry,
  };
}
