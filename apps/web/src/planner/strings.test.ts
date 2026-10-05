import { describe, expect, it } from "vitest";
import { plannerStringsFor } from "./strings";

const en = plannerStringsFor("en-US");
const zh = plannerStringsFor("zh-CN");

type Leaf = string | ((...args: never[]) => string);

/** Every leaf of a strings tree, as `path` and a flag for template functions. */
function leaves(value: unknown, path = ""): { path: string; fn: boolean }[] {
  if (typeof value === "string") return [{ path, fn: false }];
  if (typeof value === "function") return [{ path, fn: true }];
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => leaves(child, path ? `${path}.${key}` : key),
  );
}

function read(root: unknown, path: string): Leaf {
  return path
    .split(".")
    .reduce<unknown>(
      (node, key) => (node as Record<string, unknown>)[key],
      root,
    ) as Leaf;
}

describe("plannerStringsFor", () => {
  it("speaks Chinese for zh-CN and English for every other app language", () => {
    expect(plannerStringsFor("zh-CN").title).toBe("驾驶舱");
    for (const locale of ["en-US", "ja", "fr", "es", "ko", "ru", "ar"]) {
      expect(plannerStringsFor(locale)).toBe(en);
    }
    expect(plannerStringsFor("something-else")).toBe(en);
  });

  it("gives both languages the same keys, as text or as template functions", () => {
    const english = leaves(en);
    const chinese = leaves(zh);
    expect(chinese.map((leaf) => leaf.path).sort()).toEqual(
      english.map((leaf) => leaf.path).sort(),
    );
    for (const leaf of english) {
      expect(typeof read(zh, leaf.path)).toBe(typeof read(en, leaf.path));
    }
  });

  it("leaves no text empty", () => {
    for (const [name, strings] of [
      ["en", en],
      ["zh-CN", zh],
    ] as const) {
      for (const leaf of leaves(strings).filter((entry) => !entry.fn)) {
        const text = read(strings, leaf.path) as string;
        expect(text.trim().length, `${name}:${leaf.path}`).toBeGreaterThan(0);
      }
    }
  });

  it("names the page and the nav link the same", () => {
    expect(en.nav).toBe("Cockpit");
    expect(en.title).toBe("Cockpit");
    expect(zh.nav).toBe("驾驶舱");
    expect(zh.title).toBe("驾驶舱");
  });

  it("keeps the four columns in the order the board shows them", () => {
    expect([
      en.column.backlog,
      en.column.todo,
      en.column.doing,
      en.column.done,
    ]).toEqual(["Backlog", "To Do", "Doing", "Done"]);
  });

  it("pluralises the carry-over toast", () => {
    expect(en.toast.carried(1)).toBe("1 unfinished task carried forward");
    expect(en.toast.carried(3)).toBe("3 unfinished tasks carried forward");
    expect(zh.toast.carried(3)).toBe("3 项未完成任务已顺延");
  });

  it("writes the carried badge as ×N", () => {
    expect(en.card.carried(2)).toBe("Carried ×2");
    expect(zh.card.carried(2)).toBe("顺延 ×2");
  });

  it("keeps Chinese text to full-width punctuation and the single ellipsis character", () => {
    const text = leaves(zh)
      .filter((leaf) => !leaf.fn)
      .map((leaf) => read(zh, leaf.path) as string);
    for (const line of text) {
      expect(line, line).not.toMatch(/[一-鿿][,.!?:;]/);
      expect(line, line).not.toContain("...");
    }
    for (const line of leaves(en)
      .filter((leaf) => !leaf.fn)
      .map((leaf) => read(en, leaf.path) as string)) {
      expect(line, line).not.toContain("...");
    }
  });
});
