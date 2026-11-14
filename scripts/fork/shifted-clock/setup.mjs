// Fork: moves the test clock to FLAREMO_TEST_NOW so date bugs show up before
// the calendar reaches them. Only Date is faked and it keeps ticking, so
// timers, timeouts and Miniflare behave as usual. A test that pins its own
// clock (vi.useFakeTimers / vi.setSystemTime) still wins.
import { vi } from "vitest";

const now = process.env.FLAREMO_TEST_NOW;
if (now) {
  const at = new Date(now);
  if (Number.isNaN(at.getTime())) {
    throw new Error(`FLAREMO_TEST_NOW is not a date: ${now}`);
  }
  vi.useFakeTimers({ now: at, shouldAdvanceTime: true, toFake: ["Date"] });
}
