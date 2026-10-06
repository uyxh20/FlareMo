import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlannerAutosave,
  type PlannerAutosaveState,
  plannerAutosaveDelayMs,
  plannerAutosaveMinGapMs,
} from "./use-planner-autosave";

// The notes' autosave rules, with fake timers: a debounce of 800 ms, a gap of 5 s
// between the saves the typing timer starts, a save on blur, no overlapping saves,
// and a failed save that keeps the text. Three older cases (the two about overlap
// and the one about retrying) run with the gap off, because the gap only moves
// their timings; the gap has its own block at the end, which says the same things
// again with it on.

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A controller whose saves the test settles by hand. */
function setup(
  saved = "",
  options: { minGapMs?: number; now?: () => number } = {},
) {
  const sent: string[] = [];
  const pending: Deferred[] = [];
  const states: PlannerAutosaveState[] = [];
  const controller = createPlannerAutosave({
    saved,
    save: (value) => {
      sent.push(value);
      const next = deferred();
      pending.push(next);
      return next.promise;
    },
    onState: (state) => states.push(state),
    ...options,
  });
  /** Settles the oldest save the test has not settled yet. */
  const finish = async (result: "ok" | Error = "ok") => {
    const next = pending.shift();
    if (!next) throw new Error("no save in flight");
    if (result === "ok") next.resolve();
    else next.reject(result);
    await vi.advanceTimersByTimeAsync(0);
  };
  const statuses = () => states.map((state) => state.status);
  return { controller, sent, states, statuses, finish };
}

describe("createPlannerAutosave", () => {
  it("saves 800 ms after typing stops, with the text as it is then", async () => {
    expect(plannerAutosaveDelayMs).toBe(800);
    const { controller, sent, finish } = setup();

    controller.change("h");
    controller.change("he");
    controller.change("hello");
    await vi.advanceTimersByTimeAsync(799);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(["hello"]);

    await finish();
    expect(controller.getState()).toEqual({ value: "hello", status: "saved" });
  });

  it("starts the wait again with every key: a pause of 800 ms is what saves", async () => {
    const { controller, sent } = setup();
    controller.change("a");
    await vi.advanceTimersByTimeAsync(700);
    controller.change("ab");
    await vi.advanceTimersByTimeAsync(700);
    controller.change("abc");
    await vi.advanceTimersByTimeAsync(700);
    // Never 800 ms without a key yet.
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(sent).toEqual(["abc"]);
  });

  it("walks through dirty, saving and saved", async () => {
    const { controller, statuses, finish } = setup();
    controller.change("x");
    await vi.advanceTimersByTimeAsync(800);
    await finish();
    expect(statuses()).toEqual(["dirty", "saving", "saved"]);
  });

  it("saves at once when the field loses focus", async () => {
    const { controller, sent } = setup();
    controller.change("typed");
    controller.flush();
    expect(sent).toEqual(["typed"]);
    // The wait that was running is gone: it does not send a second copy.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual(["typed"]);
  });

  it("does nothing on a blur when nothing changed", async () => {
    const { controller, sent, statuses } = setup("saved text");
    controller.flush();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);
    expect(statuses()).toEqual([]);
  });

  it("does not save a change that the server would trim away", async () => {
    const { controller, sent } = setup("hello");
    controller.change("hello ");
    controller.change(" hello\n");
    await vi.advanceTimersByTimeAsync(2_000);
    controller.flush();
    expect(sent).toEqual([]);
  });

  it("does not save when the text is typed back to what is saved", async () => {
    const { controller, sent, statuses } = setup("original");
    controller.change("original!");
    controller.change("original");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sent).toEqual([]);
    expect(statuses()).toEqual(["dirty", "idle"]);
  });

  it("saves an emptied field as an empty string", async () => {
    const { controller, sent } = setup("something");
    controller.change("");
    await vi.advanceTimersByTimeAsync(800);
    expect(sent).toEqual([""]);
  });

  it("never runs two saves at once: typing during a save sends one more afterwards, with the newest text", async () => {
    // The gap is off: this case is about overlap, and the gap's own block below
    // says the same with it on.
    const { controller, sent, finish } = setup("", { minGapMs: 0 });

    controller.change("one");
    await vi.advanceTimersByTimeAsync(800);
    expect(sent).toEqual(["one"]);

    // The first save is still out. Type more, and let that timer run out too.
    controller.change("one two");
    controller.change("one two three");
    await vi.advanceTimersByTimeAsync(800);
    expect(sent).toEqual(["one"]);
    expect(controller.getState().status).toBe("saving");

    await finish();
    expect(sent).toEqual(["one", "one two three"]);
    await finish();
    expect(controller.getState()).toEqual({
      value: "one two three",
      status: "saved",
    });
  });

  it("waits out a still-running pause instead of saving again at once", async () => {
    // The gap is off, as above.
    const { controller, sent, finish } = setup("", { minGapMs: 0 });
    controller.change("one");
    await vi.advanceTimersByTimeAsync(800);
    controller.change("one two");
    await finish();
    // The save is over but the person is still typing: the pause is still on.
    expect(sent).toEqual(["one"]);
    expect(controller.getState().status).toBe("dirty");
    await vi.advanceTimersByTimeAsync(800);
    expect(sent).toEqual(["one", "one two"]);
  });

  it("keeps the typed text and says so when a save fails", async () => {
    const { controller, sent, finish } = setup("old");
    controller.change("new text");
    await vi.advanceTimersByTimeAsync(800);
    await finish(new Error("offline"));

    expect(controller.getState()).toEqual({
      value: "new text",
      status: "error",
    });
    // Nothing is sent again on its own.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual(["new text"]);
  });

  it("tries again on retry, on the next blur and on the next keystroke", async () => {
    // The gap is off: with it on, the keystroke waits (see the gap's block below).
    const { controller, sent, finish } = setup("", { minGapMs: 0 });
    controller.change("a");
    await vi.advanceTimersByTimeAsync(800);
    await finish(new Error("offline"));

    controller.retry();
    expect(sent).toEqual(["a", "a"]);
    await finish(new Error("still offline"));

    controller.flush();
    expect(sent).toEqual(["a", "a", "a"]);
    await finish(new Error("still offline"));

    controller.change("ab");
    expect(controller.getState().status).toBe("dirty");
    await vi.advanceTimersByTimeAsync(800);
    expect(sent).toEqual(["a", "a", "a", "ab"]);
    await finish();
    expect(controller.getState()).toEqual({ value: "ab", status: "saved" });
  });

  it("treats the failed text as unsaved: the same text is sent again, not skipped", async () => {
    const { controller, sent, finish } = setup("");
    controller.change("keep");
    await vi.advanceTimersByTimeAsync(800);
    await finish(new Error("nope"));
    controller.flush();
    expect(sent).toEqual(["keep", "keep"]);
  });

  describe("reset", () => {
    it("adopts the server's text while nothing here is unsaved", () => {
      const { controller, statuses } = setup("v1");
      controller.reset("v2");
      expect(controller.getState()).toEqual({ value: "v2", status: "idle" });
      expect(statuses()).toEqual(["idle"]);
    });

    it("adopts it after a save too, and does not announce a change that is not one", async () => {
      const { controller, finish, states } = setup();
      controller.change("hello ");
      await vi.advanceTimersByTimeAsync(800);
      await finish();
      const announced = states.length;

      // The server trimmed the text it was sent: that is the same notes.
      controller.reset("hello");
      expect(controller.getState().value).toBe("hello ");
      expect(states).toHaveLength(announced);

      controller.reset("changed elsewhere");
      expect(controller.getState().value).toBe("changed elsewhere");
    });

    it("leaves typed text alone while it is unsaved, saving or failed", async () => {
      const { controller, finish } = setup("v1");
      controller.change("typing");
      controller.reset("from the server");
      expect(controller.getState().value).toBe("typing");

      await vi.advanceTimersByTimeAsync(800);
      expect(controller.getState().status).toBe("saving");
      controller.reset("again from the server");
      expect(controller.getState().value).toBe("typing");

      await finish(new Error("offline"));
      controller.reset("a third time");
      expect(controller.getState()).toEqual({
        value: "typing",
        status: "error",
      });
    });

    it("compares what is typed with the server's text it was given last", async () => {
      const { controller, sent } = setup("v1");
      controller.reset("v2");
      // Typing back to v2 is no change; typing v1 again is one.
      controller.change("v2");
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual([]);
      controller.change("v1");
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual(["v1"]);
    });
  });

  describe("dispose", () => {
    it("saves what is left when the panel goes away mid-pause", () => {
      const { controller, sent } = setup();
      controller.change("unsaved words");
      controller.dispose();
      expect(sent).toEqual(["unsaved words"]);
    });

    it("saves nothing when everything is already saved", async () => {
      const { controller, sent, finish } = setup();
      controller.change("done");
      await vi.advanceTimersByTimeAsync(800);
      await finish();
      controller.dispose();
      expect(sent).toEqual(["done"]);
    });

    it("sends the newest text after a save that is still out", async () => {
      const { controller, sent, finish } = setup();
      controller.change("first");
      await vi.advanceTimersByTimeAsync(800);
      controller.change("first and more");
      controller.dispose();
      expect(sent).toEqual(["first"]);
      await finish();
      expect(sent).toEqual(["first", "first and more"]);
    });

    it("stops the pause, so it does not save a second time later", async () => {
      const { controller, sent } = setup();
      controller.change("once");
      controller.dispose();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent).toEqual(["once"]);
    });
  });

  // Every save is a write in the shared `planner` rate-limit bucket (30 a minute),
  // so the typing timer may not start one less than 5 s after the previous one
  // began. A pause that ends sooner is held for what is left of the gap; a blur,
  // Enter, retry() and dispose() are the person saying "now" and go ahead.
  describe("the minimum gap between saves", () => {
    /** A controller whose saves finish at once, with when each one began. */
    function instant() {
      const saves: { at: number; value: string }[] = [];
      const controller = createPlannerAutosave({
        saved: "",
        save: async (value) => {
          saves.push({ at: Date.now(), value });
        },
      });
      return { controller, saves };
    }

    it("is 5 s unless it is told otherwise: at most 12 saves a minute", () => {
      expect(plannerAutosaveMinGapMs).toBe(5_000);
      expect(60_000 / plannerAutosaveMinGapMs).toBe(12);
    });

    it("holds a minute of steady typing to 12 saves, 5 s apart, and still saves the last text", async () => {
      const { controller, saves } = instant();
      const start = Date.now();
      // A burst of typing, then a pause of 1 s, for a minute. A pause of 1 s is
      // longer than the 800 ms that saves, so without the gap every one of them
      // would be a save.
      for (let second = 0; second < 60; second += 1) {
        controller.change(`text ${second}`);
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(Date.now() - start).toBe(60_000);
      expect(saves.length).toBeGreaterThan(1);
      expect(saves.length).toBeLessThanOrEqual(12);
      // Never two saves closer than the gap, counted from start to start.
      for (let index = 1; index < saves.length; index += 1) {
        const gap = (saves[index]?.at ?? 0) - (saves[index - 1]?.at ?? 0);
        expect(gap).toBeGreaterThanOrEqual(plannerAutosaveMinGapMs);
      }

      // Typing stops. The text that was being held is not dropped: it goes out
      // when the gap allows, and it is the last text.
      await vi.advanceTimersByTimeAsync(plannerAutosaveMinGapMs);
      expect(saves.at(-1)?.value).toBe("text 59");
      expect(controller.getState()).toEqual({
        value: "text 59",
        status: "saved",
      });
    });

    it("holds a pause that ends inside the gap until the gap is over, then saves the newest text", async () => {
      const { controller, saves } = instant();
      controller.change("one");
      // Nothing came before it, so there is nothing to wait for.
      await vi.advanceTimersByTimeAsync(800);
      expect(saves.map((save) => save.value)).toEqual(["one"]);

      controller.change("one two");
      await vi.advanceTimersByTimeAsync(800);
      // The pause ran out 1.6 s in, inside the gap: held, still unsaved.
      expect(saves).toHaveLength(1);
      expect(controller.getState().status).toBe("dirty");

      // More typing while it is held starts the pause again, and the text it
      // sends in the end is the newest.
      controller.change("one two three");
      await vi.advanceTimersByTimeAsync(3_000);
      expect(saves).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_199);
      expect(saves).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(saves.map((save) => save.value)).toEqual(["one", "one two three"]);
      // Exactly 5 s after the first one began (800 ms + 5 s).
      expect((saves[1]?.at ?? 0) - (saves[0]?.at ?? 0)).toBe(5_000);
    });

    it("counts the gap from the start of the previous save, not from its end", async () => {
      const { controller, sent, finish } = setup();
      controller.change("one");
      await vi.advanceTimersByTimeAsync(800);
      // A slow save: it began at 800 ms and ends at 3.8 s.
      await vi.advanceTimersByTimeAsync(3_000);
      await finish();

      controller.change("one two");
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual(["one"]);
      await vi.advanceTimersByTimeAsync(1_199);
      expect(sent).toEqual(["one"]);
      // 5.8 s: 5 s after the first save began, not 5 s after it ended (8.8 s).
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual(["one", "one two"]);
    });

    it("counts a save a blur started: typing right after it waits out the gap too", async () => {
      const { controller, sent, finish } = setup();
      controller.change("one");
      controller.flush();
      await finish();

      controller.change("one two");
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual(["one"]);
      await vi.advanceTimersByTimeAsync(4_199);
      expect(sent).toEqual(["one"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual(["one", "one two"]);
    });

    it("saves at once on a blur inside the gap, and the held pause does not send a second copy", async () => {
      const { controller, sent, finish } = setup();
      controller.change("one");
      await vi.advanceTimersByTimeAsync(800);
      await finish();

      controller.change("one two");
      await vi.advanceTimersByTimeAsync(800);
      // The pause is being held, 1.6 s in.
      expect(sent).toEqual(["one"]);
      controller.flush();
      expect(sent).toEqual(["one", "one two"]);
      await finish();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(sent).toEqual(["one", "one two"]);
    });

    it("saves at once when the panel goes away inside the gap, whether the pause is running or being held", async () => {
      const running = setup();
      running.controller.change("one");
      await vi.advanceTimersByTimeAsync(800);
      await running.finish();
      running.controller.change("one two");
      // Typed 0 ms ago: the pause is still running, and the gap is far from over.
      running.controller.dispose();
      expect(running.sent).toEqual(["one", "one two"]);
      await running.finish();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(running.sent).toEqual(["one", "one two"]);

      const held = setup();
      held.controller.change("one");
      await vi.advanceTimersByTimeAsync(800);
      await held.finish();
      held.controller.change("one two");
      await vi.advanceTimersByTimeAsync(800);
      expect(held.sent).toEqual(["one"]);
      held.controller.dispose();
      expect(held.sent).toEqual(["one", "one two"]);
      await held.finish();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(held.sent).toEqual(["one", "one two"]);
    });

    it("after a failed save, typing still waits out the gap while retry() does not", async () => {
      const { controller, sent, finish } = setup();
      controller.change("one");
      await vi.advanceTimersByTimeAsync(800);
      await finish(new Error("offline"));
      expect(controller.getState().status).toBe("error");

      // The failed save began at 800 ms. Typing on holds the text until 5.8 s.
      controller.change("one two");
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual(["one"]);

      // retry() is the person pressing Retry, 1.6 s in: it goes at once.
      controller.retry();
      expect(sent).toEqual(["one", "one two"]);
      await finish(new Error("still offline"));

      // That retry began the gap again, at 1.6 s: typing waits until 6.6 s.
      controller.change("one two three");
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual(["one", "one two"]);
      await vi.advanceTimersByTimeAsync(4_199);
      expect(sent).toEqual(["one", "one two"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual(["one", "one two", "one two three"]);
      await finish();
      expect(controller.getState()).toEqual({
        value: "one two three",
        status: "saved",
      });
    });

    it("never runs two saves at once: typing during a save is sent after the gap, with the newest text", async () => {
      const { controller, sent, finish } = setup();
      controller.change("one");
      await vi.advanceTimersByTimeAsync(800);

      // The first save is still out. Type more, and let that pause run out too.
      controller.change("one two");
      controller.change("one two three");
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual(["one"]);
      expect(controller.getState().status).toBe("saving");

      // The save is over but the gap is not: the text waits, its pause still on.
      await finish();
      expect(sent).toEqual(["one"]);
      expect(controller.getState().status).toBe("dirty");
      await vi.advanceTimersByTimeAsync(4_199);
      expect(sent).toEqual(["one"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual(["one", "one two three"]);
      await finish();
      expect(controller.getState()).toEqual({
        value: "one two three",
        status: "saved",
      });
    });

    it("queues a pause that ends after the gap while a slow save is still out, and sends it the moment that save ends", async () => {
      const { controller, sent, finish } = setup();
      controller.change("one");
      await vi.advanceTimersByTimeAsync(800);
      // The save began at 800 ms and stays out past the gap (5.8 s).
      await vi.advanceTimersByTimeAsync(4_700);
      controller.change("one two");
      await vi.advanceTimersByTimeAsync(800);
      // The pause ran out at 6.3 s, past the gap but with the save still out.
      expect(sent).toEqual(["one"]);
      expect(controller.getState().status).toBe("saving");
      await finish();
      expect(sent).toEqual(["one", "one two"]);
    });

    it("still queues a blur that arrives during a save, and sends it the moment that save ends, gap or not", async () => {
      const { controller, sent, finish } = setup();
      controller.change("one");
      await vi.advanceTimersByTimeAsync(800);

      controller.change("one two");
      controller.flush();
      expect(sent).toEqual(["one"]);
      // 0 ms into a 5 s gap, and it goes the moment the first save ends.
      await finish();
      expect(sent).toEqual(["one", "one two"]);
    });

    it("measures the gap with the clock it is given", async () => {
      let clock = 0;
      const { controller, sent, finish } = setup("", { now: () => clock });
      controller.change("one");
      await vi.advanceTimersByTimeAsync(800);
      await finish();

      // The given clock says 4 s have passed since that save began.
      clock = 4_000;
      controller.change("one two");
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual(["one"]);

      // 1 s of the gap is left, so the pause was held for exactly that.
      clock = 5_000;
      await vi.advanceTimersByTimeAsync(999);
      expect(sent).toEqual(["one"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(sent).toEqual(["one", "one two"]);
    });

    it("does not hold the text when the clock has been set back: the gap cannot be measured", async () => {
      let clock = 1_000_000;
      const { controller, sent, finish } = setup("", { now: () => clock });
      controller.change("one");
      await vi.advanceTimersByTimeAsync(800);
      await finish();

      clock = 0;
      controller.change("one two");
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual(["one", "one two"]);
    });

    it("is off with a gap of 0: every pause saves", async () => {
      const { controller, sent, finish } = setup("", { minGapMs: 0 });
      controller.change("one");
      await vi.advanceTimersByTimeAsync(800);
      await finish();
      controller.change("one two");
      await vi.advanceTimersByTimeAsync(800);
      expect(sent).toEqual(["one", "one two"]);
    });
  });
});
