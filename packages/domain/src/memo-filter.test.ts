import type { AttachmentRow, MemoRow, UserRow } from "@flaremo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileAttachmentFilter, compileMemoFilter } from "./memo-filter";

const user = {
  id: "users/owner",
} as UserRow;

const memo = {
  id: "memos/one",
  content: "roadmap for urgent launch",
  pinned: true,
  visibility: "public",
  status: "normal",
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  payload: {
    tags: ["urgent", "launch"],
    property: { has_link: true },
  },
} as MemoRow;

const attachment = {
  id: "attachments/one",
  filename: "report.pdf",
  contentType: "application/pdf",
  memoId: "memos/one",
  createdAt: "2026-08-01T00:00:00.000Z",
} as AttachmentRow;

describe("Memos CEL filter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("evaluates upstream-style boolean, string and list macros", async () => {
    const matches = await compileMemoFilter(
      'pinned == true && content.contains("roadmap") && tags.exists(t, t == "urgent")',
    );
    expect(matches?.(memo, user)).toBe(true);
  });

  it("supports timestamp and now/duration expressions", async () => {
    expect(
      (
        await compileMemoFilter(
          'created_ts > timestamp(1704067200) && updated_ts <= now - duration("1h")',
        )
      )?.(memo, user),
    ).toBe(true);
  });

  it("supports upstream size and timestamp accessor functions", async () => {
    expect((await compileMemoFilter("size(content) == 25"))?.(memo, user)).toBe(
      true,
    );
    expect((await compileMemoFilter("content.size() > 20"))?.(memo, user)).toBe(
      true,
    );
    expect((await compileMemoFilter("size(tags) == 2"))?.(memo, user)).toBe(
      true,
    );
    expect(
      (await compileMemoFilter("created_ts.getFullYear() == 2026"))?.(
        memo,
        user,
      ),
    ).toBe(true);
    expect(
      (await compileMemoFilter("created_ts.getMonth() == 7"))?.(memo, user),
    ).toBe(true);
    await expect(
      compileMemoFilter('created_ts.getMonth("UTC") == 7'),
    ).rejects.toThrow(/timezone argument/);
    await expect(
      compileMemoFilter("now.getFullYear() == 2026"),
    ).rejects.toThrow(/timestamp fields/);
  });

  it("matches Memos creator identity, numeric id, and virtual tag membership", async () => {
    expect(
      (
        await compileMemoFilter(
          'creator == "users/owner" && creator_id == 1 && tag in ["urgent"]',
        )
      )?.(memo, user),
    ).toBe(true);

    expect((await compileMemoFilter('tag in ["missing"]'))?.(memo, user)).toBe(
      false,
    );

    const caseSensitive = await compileMemoFilter('tag in ["URGENT"]');
    expect(caseSensitive?.(memo, user)).toBe(false);
  });

  it("keeps tag aliases atomic across boolean expressions and supports hierarchy", async () => {
    const hierarchical = {
      ...memo,
      pinned: false,
      payload: { tags: ["book/fiction"], property: {} },
    } as MemoRow;
    expect(
      (await compileMemoFilter('tag in ["book"]'))?.(hierarchical, user),
    ).toBe(true);

    const pinnedWithoutTags = {
      ...memo,
      pinned: true,
      payload: { tags: [], property: {} },
    } as MemoRow;
    expect(
      (await compileMemoFilter('tag in ["book"] || pinned'))?.(
        pinnedWithoutTags,
        user,
      ),
    ).toBe(true);
    expect(
      (await compileMemoFilter('tag in ["book"] && pinned'))?.(
        pinnedWithoutTags,
        user,
      ),
    ).toBe(false);
    expect(
      (await compileMemoFilter('!(tag in ["book"])'))?.(
        pinnedWithoutTags,
        user,
      ),
    ).toBe(true);
  });

  it("uses case-insensitive string matching and validates regexes once", async () => {
    expect(
      (await compileMemoFilter('content.contains("ROADMAP")'))?.(memo, user),
    ).toBe(true);
    expect(
      (await compileMemoFilter('content.startsWith("ROAD")'))?.(memo, user),
    ).toBe(true);
    expect(
      (await compileMemoFilter('content.endsWith("LAUNCH")'))?.(memo, user),
    ).toBe(true);
    expect(
      (await compileMemoFilter('content.matches("road.*launch")'))?.(
        memo,
        user,
      ),
    ).toBe(true);
    await expect(compileMemoFilter('content.matches("[")')).rejects.toThrow(
      "Invalid Memos CEL filter",
    );
    await expect(
      compileMemoFilter('content.matches("(?=road)")'),
    ).rejects.toThrow("Invalid Memos CEL filter");
  });

  it("rejects super-linear regex shapes that enable catastrophic backtracking", async () => {
    // Quantifier over a group containing alternation.
    await expect(
      compileMemoFilter('content.matches("(a|aa)+$")'),
    ).rejects.toThrow("Invalid Memos CEL filter");
    // Quantifier over a group containing a quantifier (classic nested form).
    await expect(
      compileMemoFilter('content.matches("(a+)+$")'),
    ).rejects.toThrow("Invalid Memos CEL filter");
    await expect(
      compileMemoFilter('content.matches("(?:x+y)+$")'),
    ).rejects.toThrow("Invalid Memos CEL filter");
    // Quantifier over a group with an inner bounded quantifier still counts.
    await expect(
      compileMemoFilter('content.matches("(a?b)+$")'),
    ).rejects.toThrow("Invalid Memos CEL filter");
    // Linear shapes keep working.
    expect(
      (await compileMemoFilter('content.matches("(abc)+")'))?.(memo, user),
    ).toBe(false);
    expect(
      (await compileMemoFilter('content.matches("a*b+c?")'))?.(memo, user),
    ).toBe(false);
    expect(
      (await compileMemoFilter('content.matches("[ab]+road")'))?.(memo, user),
    ).toBe(false);
  });

  it("supports the upstream set helpers and non-vacuous tags.all", async () => {
    expect(
      (
        await compileMemoFilter(
          'sets.contains(tags, ["urgent", "launch"]) && sets.intersects(tags, ["launch"])',
        )
      )?.(memo, user),
    ).toBe(true);
    expect(
      (
        await compileMemoFilter('sets.equivalent(tags, ["launch", "urgent"])')
      )?.(memo, user),
    ).toBe(true);

    const emptyTags = { ...memo, payload: { property: {} } } as MemoRow;
    // CEL spec: all() over an empty list is vacuously true.
    expect(
      (await compileMemoFilter('tags.all(t, t.startsWith("work"))'))?.(
        emptyTags,
        user,
      ),
    ).toBe(true);
    expect(
      (await compileMemoFilter('!tags.all(t, t.startsWith("work"))'))?.(
        emptyTags,
        user,
      ),
    ).toBe(false);
  });

  it("freezes now once when the filter is compiled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00.000Z"));
    const matches = await compileMemoFilter(
      'created_ts < now && now < timestamp("2026-08-05T00:00:00Z")',
    );
    vi.setSystemTime(new Date("2026-08-06T00:00:00.000Z"));
    expect(matches?.(memo, user)).toBe(true);
  });

  it("rejects invalid expressions and limits input size", async () => {
    await expect(compileMemoFilter("pinned ==")).rejects.toThrow(
      "Invalid Memos CEL filter",
    );
    await expect(compileMemoFilter("x".repeat(4_097))).rejects.toThrow(
      "Memos filter is too long",
    );
    await expect(compileMemoFilter("1")).rejects.toThrow(
      "filter must evaluate to a boolean",
    );
    await expect(
      compileMemoFilter('timestamp("garbage") < now'),
    ).rejects.toThrow("Invalid Memos CEL filter");
    await expect(
      compileMemoFilter('duration("garbage") > duration("1s")'),
    ).rejects.toThrow("Invalid Memos CEL filter");
    await expect(compileMemoFilter('visibility < "PUBLIC"')).rejects.toThrow(
      "Invalid Memos CEL filter",
    );
    await expect(compileMemoFilter('tag == "urgent"')).rejects.toThrow(
      "Invalid Memos CEL filter",
    );
    await expect(compileMemoFilter("tags.map(t, t)")).rejects.toThrow(
      "Invalid Memos CEL filter",
    );
    await expect(
      compileMemoFilter('content.substring(0, 2) == "road"'),
    ).rejects.toThrow("Invalid Memos CEL filter");
    await expect(
      compileMemoFilter('created_ts.getHours("UTC") >= 0'),
    ).rejects.toThrow("timezone argument");
    await expect(compileMemoFilter("size(pinned)")).rejects.toThrow(
      "Invalid Memos CEL filter",
    );
  });

  it("normalizes only code and preserves string literals", async () => {
    expect(
      (await compileMemoFilter('sets . contains ( tags, ["urgent"] )'))?.(
        memo,
        user,
      ),
    ).toBe(true);
    const singleTagMemo = {
      ...memo,
      payload: { tags: ["urgent"], property: {} },
    } as MemoRow;
    expect(
      (await compileMemoFilter('tags . all (t, t.startsWith("URGENT"))'))?.(
        singleTagMemo,
        user,
      ),
    ).toBe(true);

    const literalMemo = { ...memo, content: "sets.contains(" } as MemoRow;
    expect(
      (await compileMemoFilter('content.contains("sets.contains(")'))?.(
        literalMemo,
        user,
      ),
    ).toBe(true);
  });
});

describe("Memos Attachment CEL filter", () => {
  it("supports text matching, in, memo identity, and time arithmetic", async () => {
    expect(
      (
        await compileAttachmentFilter(
          'filename.contains("REPORT") && mime_type in ["application/pdf", "image/png"]',
        )
      )?.(attachment),
    ).toBe(true);
    expect(
      (
        await compileAttachmentFilter(
          'memo_id == "memos/one" && create_time < now + duration("1h")',
        )
      )?.(attachment),
    ).toBe(true);
    expect(
      (await compileAttachmentFilter('memo == "memos/missing"'))?.(attachment),
    ).toBe(false);
  });

  it("preserves nullable memo_id semantics for unbound attachments", async () => {
    const unbound = { ...attachment, memoId: null } as AttachmentRow;
    expect((await compileAttachmentFilter("memo_id == null"))?.(unbound)).toBe(
      true,
    );
    expect((await compileAttachmentFilter("memo_id != null"))?.(unbound)).toBe(
      false,
    );
    expect(
      (await compileAttachmentFilter("memo_id != null"))?.(attachment),
    ).toBe(true);
  });

  it("supports attachment regexes and rejects fields outside the pinned schema", async () => {
    expect(
      (await compileAttachmentFilter('mime_type.matches("^application/")'))?.(
        attachment,
      ),
    ).toBe(true);
    await expect(
      compileAttachmentFilter("tags.exists(t, true)"),
    ).rejects.toThrow("Invalid Memos CEL filter");
    await expect(compileAttachmentFilter("unknown == true")).rejects.toThrow(
      "Invalid Memos CEL filter",
    );
  });
});

describe("Memos CEL filter SQL pushdown completeness", () => {
  it("marks comparisons of pinned/state/visibility and their boolean chains complete", async () => {
    expect((await compileMemoFilter("pinned == true"))?.completeInSql).toBe(
      true,
    );
    expect((await compileMemoFilter("pinned == false"))?.completeInSql).toBe(
      true,
    );
    expect((await compileMemoFilter('state == "NORMAL"'))?.completeInSql).toBe(
      true,
    );
    expect(
      (await compileMemoFilter('visibility == "PUBLIC"'))?.completeInSql,
    ).toBe(true);
    expect(
      (await compileMemoFilter('pinned == true && state == "NORMAL"'))
        ?.completeInSql,
    ).toBe(true);
    expect(
      (await compileMemoFilter('pinned == true || state == "NORMAL"'))
        ?.completeInSql,
    ).toBe(true);
  });

  it("marks expressions with JS-evaluated leaves incomplete", async () => {
    expect(
      (await compileMemoFilter('content.contains("roadmap")'))?.completeInSql,
    ).toBe(false);
    expect(
      (await compileMemoFilter('pinned == true && content.contains("roadmap")'))
        ?.completeInSql,
    ).toBe(false);
    expect((await compileMemoFilter("size(tags) == 2"))?.completeInSql).toBe(
      false,
    );
  });

  it("matches JS evaluation on completely pushed-down expressions", async () => {
    const filter = await compileMemoFilter(
      'pinned == true && state == "NORMAL"',
    );
    expect(filter?.completeInSql).toBe(true);
    for (const candidate of [memo, { ...memo, pinned: false }]) {
      // SQL `upper(status) = 'NORMAL'` and the JS evaluator agree per row.
      expect(filter?.(candidate as MemoRow, user)).toBe(
        (candidate as MemoRow).pinned &&
          candidate.status.toUpperCase() === "NORMAL",
      );
    }
  });
});
