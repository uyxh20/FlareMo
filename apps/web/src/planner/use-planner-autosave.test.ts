import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlannerAutosave,
  type PlannerAutosaveState,
  plannerAutosaveDelayMs,
} from "./use-planner-autosave";

// The notes' autosave rules, with fake timers: a debounce of 800 ms, a save on
// blur, no overlapping saves, and a failed save that keeps the text.

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
function setup(saved = "") {
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
    const { controller, sent, finish } = setup();

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
    const { controller, sent, finish } = setup();
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
    const { controller, sent, finish } = setup();
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
});
