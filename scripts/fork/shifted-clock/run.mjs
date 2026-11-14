#!/usr/bin/env node
// Fork: run the fork's tests again with the clock moved to a risky date, so a
// test or a feature that quietly depends on "today" fails now instead of on
// the day the calendar gets there (the link summary test broke that way on
// 11 Nov). The date rotates by weekday so each night checks a different edge,
// and is printed so a failure can be re-run exactly:
//   FLAREMO_TEST_NOW=<date> pnpm exec vitest run --config scripts/fork/shifted-clock/vitest.config.mjs <paths>
// Usage: node scripts/fork/shifted-clock/run.mjs [--date <ISO>] [paths...]
// Limits: a test that calls vi.useRealTimers() drops the shift for the rest of
// its file, and upstream tests are not covered (they may assume today).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Times are UTC; the app's week runs on Europe/Copenhagen time.
export const SHIFTED_DATES = [
  {
    at: "2026-12-31T23:30:00Z",
    why: "half past midnight on New Year's Day, Copenhagen",
  },
  {
    at: "2027-01-03T23:30:00Z",
    why: "half past midnight on a Monday, Copenhagen (new week)",
  },
  { at: "2027-03-28T00:30:00Z", why: "the night the clocks go forward" },
  { at: "2027-10-31T00:30:00Z", why: "the night the clocks go back" },
  {
    at: "2027-02-28T23:30:00Z",
    why: "the first of a month after a short February",
  },
  { at: "2027-06-30T22:30:00Z", why: "midnight between quarters, Copenhagen" },
  { at: "2028-02-29T11:00:00Z", why: "a leap day" },
];

export const FORK_TEST_PATHS = [
  "packages/domain/src/planner",
  "packages/domain/src/health",
  "packages/domain/src/fork",
  "apps/web/src/planner",
  "apps/web/src/health",
  "apps/web/src/fork",
  "apps/worker/src/routes/planner-",
  "apps/worker/src/routes/health-api.test",
];

export function pickDate(day = new Date()) {
  return SHIFTED_DATES[day.getUTCDay() % SHIFTED_DATES.length];
}

function main(argv) {
  const dateFlag = argv.indexOf("--date");
  const chosen =
    dateFlag >= 0
      ? { at: argv[dateFlag + 1], why: "given with --date" }
      : pickDate();
  const rest = argv.filter((_, i) => i !== dateFlag && i !== dateFlag + 1);
  const paths = rest.length > 0 ? rest : FORK_TEST_PATHS;
  console.log(`Shifted clock: ${chosen.at} (${chosen.why})`);
  const config = fileURLToPath(new URL("./vitest.config.mjs", import.meta.url));
  const result = spawnSync(
    "pnpm",
    ["exec", "vitest", "run", "--config", config, ...paths],
    { stdio: "inherit", env: { ...process.env, FLAREMO_TEST_NOW: chosen.at } },
  );
  process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
