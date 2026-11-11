import { plannerMorningDirectionFor } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerCleanMorningLine,
  plannerMorningContextText,
  plannerMorningMessages,
  plannerMorningWeekday,
} from "./morning";

// The morning line's prompt pieces (fork-owned add-on,
// docs/fork-customizations.md "Morning page"): the alternating direction, the
// user turn in the tuning rounds' layout, and the answer cleaned to one line.

const context = {
  weekday: "Wednesday, 11 Nov",
  goals: [{ title: "Ship the morning page", tasks: 4, done: 1 }],
  due: [{ title: "Call the landlord", due: "2026-11-10" }],
  health: { sessions: 2, target: 4, breathDays: 3, nights: 1 },
  entries: [
    {
      day: "2026-10-25",
      time: "08:00",
      recent: false,
      text: "Older  entry\nwith lines",
    },
    {
      day: "2026-11-10",
      time: "21:30",
      recent: true,
      text: "Recent entry\nkept whole",
    },
  ],
};

describe("plannerMorningDirectionFor", () => {
  it("alternates off-plan and the model's call day by day", () => {
    // 10 Nov 2026 is day 314 of the year, 11 Nov day 315.
    expect(plannerMorningDirectionFor("2026-11-10")).toBe("away");
    expect(plannerMorningDirectionFor("2026-11-11")).toBe("free");
    expect(plannerMorningDirectionFor("2026-01-01")).toBe("free");
    expect(plannerMorningDirectionFor("2026-01-02")).toBe("away");
  });
});

describe("plannerMorningContextText", () => {
  it("lays the context out like the tuning rounds", () => {
    const text = plannerMorningContextText(context, ["Old line one."]);
    expect(text).toContain("Today is Wednesday, 11 Nov.");
    expect(text).toContain("- Ship the morning page (1/4 tasks done)");
    expect(text).toContain("- Call the landlord (due 2026-11-10)");
    expect(text).toContain(
      "This week so far: 2/4 training sessions, 3 breathwork days, 1 nights out.",
    );
    // Older entries on one line, the last three days whole.
    expect(text).toContain("[2026-10-25] Older entry with lines");
    expect(text).toContain("[2026-11-10 21:30] Recent entry\nkept whole");
    expect(text).toContain("- Old line one.");
    expect(text.endsWith("Write today's line. Reply with the line only.")).toBe(
      true,
    );
  });

  it("says so when there is nothing", () => {
    const text = plannerMorningContextText(
      { ...context, goals: [], due: [], health: null, entries: [] },
      [],
    );
    expect(text).toContain("- none set");
    expect(text).toContain("- nothing");
    expect(text).toContain("- none yet");
    expect(text).not.toContain("This week so far");
  });
});

describe("plannerMorningMessages", () => {
  it("adds the day's direction to the locked system prompt", () => {
    const away = plannerMorningMessages("away", context, []);
    expect(away.system).toMatch(/^You write the one line at the top/);
    expect(away.system).toContain("Banned clichés");
    expect(
      away.system.endsWith("would still clearly be good for them today."),
    ).toBe(true);
    expect(plannerMorningMessages("free", context, []).system).toContain(
      "Direction for this line: your call.",
    );
    // Round 3's reader list stays out.
    expect(away.system).not.toMatch(/what this reader likes/i);
  });
});

describe("plannerCleanMorningLine", () => {
  it("keeps the first line without wrapping quotes", () => {
    expect(plannerCleanMorningLine('\n"Print the photo for Ana."\n')).toBe(
      "Print the photo for Ana.",
    );
    expect(plannerCleanMorningLine("“Learn one word.”\nExtra")).toBe(
      "Learn one word.",
    );
    expect(plannerCleanMorningLine("   ")).toBe("");
  });
});

describe("plannerMorningWeekday", () => {
  it("names the day and month", () => {
    expect(plannerMorningWeekday("2026-11-10")).toBe("Tuesday 10 Nov");
  });
});
