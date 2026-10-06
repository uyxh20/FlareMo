// @vitest-environment jsdom
import { act } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import {
  type PlannerTestMount,
  plannerTestMount,
  plannerTestPageHide,
  plannerTestRestoreVisibility,
  plannerTestSetVisibility,
} from "./test-render";
import {
  type PlannerAutosaveSaveContext,
  usePlannerAutosave,
} from "./use-planner-autosave";

// The notes' autosave when the page goes away (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 13): `usePlannerAutosave`
// saves what is unsaved at once, ignoring the 5 s gap, when the page is hidden (a
// tab or app switch, and most tab closes) and on `pagehide`, and asks for that save
// to outlive the page. It does nothing when the page comes back. The state machine
// is in use-planner-autosave.test.ts; these run the hook in a page with the real
// events, and fake timers.

type Save = (
  value: string,
  context: PlannerAutosaveSaveContext,
) => Promise<void>;

let mounted: PlannerTestMount | undefined;
let autosave: ReturnType<typeof usePlannerAutosave> | undefined;
let save: Mock<Save>;

function Harness() {
  autosave = usePlannerAutosave({ saved: "", save });
  return null;
}

/** Mounted by the test, so that it can spy on the page's listeners first. */
function mount() {
  mounted = plannerTestMount(<Harness />);
}

function type(text: string) {
  act(() => {
    autosave?.onChange(text);
  });
}

/** Lets time pass, and the saves that finish in it. */
async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  // Date too: the gap between saves is measured with the clock.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  save = vi.fn<Save>(async () => undefined);
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  autosave = undefined;
  plannerTestRestoreVisibility();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("saving when the page goes away", () => {
  it("saves at once when the page is hidden, even inside the gap, as a request that outlives the page", async () => {
    mount();
    type("one");
    await wait(800);
    expect(save).toHaveBeenCalledTimes(1);
    // The typing timer's save is an ordinary one.
    expect(save).toHaveBeenLastCalledWith("one", { keepalive: false });

    // 0 ms into the 5 s gap, so the typing timer would hold this text.
    type("one two");
    plannerTestSetVisibility("hidden");
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("one two", { keepalive: true });

    // The pause that was waiting is gone: no third copy.
    await wait(10_000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("saves at once when the page is hidden while the text is being held for the gap", async () => {
    mount();
    type("one");
    await wait(800);
    type("one two");
    // The pause ran out 1.6 s in, inside the gap, and is being held.
    await wait(800);
    expect(save).toHaveBeenCalledTimes(1);

    plannerTestSetVisibility("hidden");
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("one two", { keepalive: true });
    await wait(10_000);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the page becomes visible: text held for the gap stays held", async () => {
    mount();
    type("one");
    await wait(800);
    type("one two");
    await wait(800);
    expect(save).toHaveBeenCalledTimes(1);

    plannerTestSetVisibility("visible");
    expect(save).toHaveBeenCalledTimes(1);

    // The gap ends as it would have, and the held text goes out the ordinary way.
    await wait(4_200);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("one two", { keepalive: false });
  });

  it("saves on the way into the background only: hidden saves, and coming back sends nothing more", async () => {
    mount();
    type("one two");
    plannerTestSetVisibility("hidden");
    expect(save).toHaveBeenCalledTimes(1);

    plannerTestSetVisibility("visible");
    await wait(10_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("saves at once on pagehide, as a request that outlives the page", () => {
    mount();
    type("first words");
    plannerTestPageHide();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("first words", { keepalive: true });
  });

  it("sends nothing when nothing is unsaved", async () => {
    mount();
    plannerTestSetVisibility("hidden");
    plannerTestPageHide();
    expect(save).not.toHaveBeenCalled();

    // Nor once what was typed has been saved.
    type("one");
    await wait(800);
    expect(save).toHaveBeenCalledTimes(1);
    plannerTestSetVisibility("hidden");
    plannerTestPageHide();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("sends one request for a tab closing, which hides the page and then fires pagehide", async () => {
    let finish!: () => void;
    save.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    mount();
    type("one two");
    plannerTestSetVisibility("hidden");
    plannerTestPageHide();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("one two", { keepalive: true });

    await act(async () => {
      finish();
    });
    await wait(10_000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("takes both listeners off when it unmounts, and puts each on once however often it renders", () => {
    const addToDocument = vi.spyOn(document, "addEventListener");
    const removeFromDocument = vi.spyOn(document, "removeEventListener");
    const addToWindow = vi.spyOn(window, "addEventListener");
    const removeFromWindow = vi.spyOn(window, "removeEventListener");

    mount();
    mounted?.rerender(<Harness />);
    mounted?.rerender(<Harness />);

    const handlersOf = (spy: typeof addToDocument, type: string) =>
      spy.mock.calls.filter(([name]) => name === type).map(([, fn]) => fn);
    const onVisibilityChange = handlersOf(addToDocument, "visibilitychange");
    const onPageHide = handlersOf(addToWindow, "pagehide");
    expect(onVisibilityChange).toHaveLength(1);
    expect(onPageHide).toHaveLength(1);

    mounted?.unmount();
    mounted = undefined;
    expect(removeFromDocument).toHaveBeenCalledWith(
      "visibilitychange",
      onVisibilityChange[0],
    );
    expect(removeFromWindow).toHaveBeenCalledWith("pagehide", onPageHide[0]);
  });
});
