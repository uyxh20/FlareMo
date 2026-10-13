import { describe, expect, it } from "vitest";
import { forkLocalInputToIso, forkLocalInputValue } from "./memo-date";

describe("memo date helpers", () => {
  it("round-trips an instant through the local input value", () => {
    const iso = "2026-03-02T09:30:00.000Z";
    expect(forkLocalInputToIso(forkLocalInputValue(iso))).toBe(iso);
  });
  it("handles empty and invalid input", () => {
    expect(forkLocalInputToIso("")).toBeNull();
    expect(forkLocalInputToIso("nope")).toBeNull();
    expect(forkLocalInputValue("nope")).toBe("");
  });
});
