import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatTimestamp } from "./date-format";

describe("formatDate", () => {
  it("renders the medium date the reader-expiry rows show", () => {
    expect(formatDate("2026-09-20T00:00:00Z", "en-US")).toMatch(
      /^Sep \d{1,2}, 2026$/,
    );
    expect(formatDate("2026-09-20T00:00:00Z", "zh-CN")).toBe("2026年9月20日");
  });

  it("falls back to the raw input when the value is not a date", () => {
    expect(formatDate("not-a-date", "en-US")).toBe("not-a-date");
  });
});

describe("formatDateTime", () => {
  it("renders medium date + short time like the token expiry rows", () => {
    const value = "2026-01-05T15:07:00Z";
    expect(formatDateTime(value, "en-US")).toMatch(
      /^Jan \d{1,2}, 2026(,)? \d{1,2}:\d{2} (AM|PM)$/,
    );
    // formatDateTime uses the host timezone (CI is UTC; many laptops are UTC+8).
    // Pin the contract to Intl, not a Shanghai-only wall clock.
    const zh = formatDateTime(value, "zh-CN");
    expect(zh).toMatch(/^2026年1月[56]日 \d{1,2}:07$/);
    expect(zh).toBe(
      new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value)),
    );
  });
});

describe("formatTimestamp", () => {
  it("matches the default toLocaleString of the memory revisions list", () => {
    const value = "2026-09-20T08:30:00Z";
    expect(formatTimestamp(value)).toBe(new Date(value).toLocaleString());
    expect(formatTimestamp("not-a-date")).toBe(
      new Date("not-a-date").toLocaleString(),
    );
  });
});
