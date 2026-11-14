import assert from "node:assert/strict";
import { test } from "node:test";
import { pickDate, SHIFTED_DATES } from "./shifted-clock/run.mjs";

test("every shifted date is a real date", () => {
  for (const { at } of SHIFTED_DATES) {
    assert.ok(!Number.isNaN(new Date(at).getTime()), at);
  }
});

test("the date changes with the weekday", () => {
  const picked = new Set();
  for (let day = 1; day <= 7; day += 1) {
    picked.add(pickDate(new Date(Date.UTC(2026, 10, day))).at);
  }
  assert.equal(picked.size, 7);
});
