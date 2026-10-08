import { describe, expect, it } from "vitest";
import {
  plannerCompareRanked,
  plannerFormatBoardRank,
  plannerIsRankKey,
  plannerParseBoardRank,
  plannerPlaceRank,
  plannerRankBetween,
  plannerRankMaxLength,
  plannerRankSpread,
} from "./planner-rank";

describe("plannerRankBetween", () => {
  it("makes a first key, and keys above and below it", () => {
    const first = plannerRankBetween(null, null);
    expect(plannerIsRankKey(first)).toBe(true);
    const above = plannerRankBetween(null, first);
    const below = plannerRankBetween(first, null);
    expect(above < first).toBe(true);
    expect(below > first).toBe(true);
  });

  it("always lands strictly between two keys, however many times it is repeated", () => {
    let low: string | null = null;
    let high: string | null = plannerRankBetween(null, null);
    // Squeeze towards the top, the bottom and the middle in turn.
    for (let step = 0; step < 300; step += 1) {
      const key = plannerRankBetween(low, high);
      expect(plannerIsRankKey(key), key).toBe(true);
      if (low !== null) expect(key > low, `${low} < ${key}`).toBe(true);
      if (high !== null) expect(key < high, `${key} < ${high}`).toBe(true);
      if (step % 3 === 0) high = key;
      else low = key;
    }
  });

  it("grows a key slowly when inserting at the same spot", () => {
    let key: string = plannerRankBetween(null, null);
    for (let step = 0; step < 20; step += 1)
      key = plannerRankBetween(null, key);
    expect(key.length).toBeLessThanOrEqual(6);
  });

  it("refuses equal or inverted keys, so the caller can re-spread", () => {
    expect(() => plannerRankBetween("a", "a")).toThrow(RangeError);
    expect(() => plannerRankBetween("b", "a")).toThrow(RangeError);
    expect(() => plannerRankBetween("a0", null)).toThrow(RangeError);
  });
});

describe("plannerRankSpread", () => {
  it("returns that many ascending, valid keys", () => {
    for (const count of [1, 2, 7, 500, 2000]) {
      const keys = plannerRankSpread(count);
      expect(keys).toHaveLength(count);
      for (const key of keys) expect(plannerIsRankKey(key), key).toBe(true);
      expect([...keys].sort()).toEqual(keys);
      expect(new Set(keys).size).toBe(count);
    }
    expect(plannerRankSpread(0)).toEqual([]);
  });

  it("leaves room between neighbours", () => {
    const keys = plannerRankSpread(500);
    for (let index = 1; index < keys.length; index += 1) {
      const key = plannerRankBetween(
        keys[index - 1] ?? null,
        keys[index] ?? null,
      );
      expect(key.length).toBeLessThanOrEqual(plannerRankMaxLength);
    }
  });
});

describe("stored ranks", () => {
  it("round-trips in a column and reads as none in any other", () => {
    const stored = plannerFormatBoardRank("todo", "aV");
    expect(stored).toBe("todo|aV");
    expect(plannerParseBoardRank(stored, "todo")).toBe("aV");
    expect(plannerParseBoardRank(stored, "doing")).toBeNull();
    expect(plannerParseBoardRank(null, "todo")).toBeNull();
    expect(plannerParseBoardRank("todo|", "todo")).toBeNull();
    expect(plannerParseBoardRank("todo|a0", "todo")).toBeNull();
  });
});

describe("plannerCompareRanked", () => {
  type Card = { id: string; key: string | null; n: number };
  const sort = (cards: Card[]) =>
    [...cards]
      .sort(
        plannerCompareRanked<Card>(
          (card) => card.key,
          (left, right) => left.n - right.n,
        ),
      )
      .map((card) => card.id);

  it("puts ranked cards first in key order, then the rest in the fallback order", () => {
    expect(
      sort([
        { id: "u2", key: null, n: 2 },
        { id: "b", key: "b", n: 9 },
        { id: "u1", key: null, n: 1 },
        { id: "a", key: "a", n: 8 },
      ]),
    ).toEqual(["a", "b", "u1", "u2"]);
  });

  it("breaks a tie between equal keys by id, the same way every time", () => {
    const cards: Card[] = [
      { id: "y", key: "k", n: 0 },
      { id: "x", key: "k", n: 0 },
    ];
    expect(sort(cards)).toEqual(["x", "y"]);
    expect(sort([...cards].reverse())).toEqual(["x", "y"]);
  });
});

describe("plannerPlaceRank", () => {
  it("takes one key between ranked neighbours, at the edges, and below the last ranked card", () => {
    expect(plannerPlaceRank([], 0)).toMatchObject({ kind: "rank" });
    const keys = ["b", "d", null, null];
    const top = plannerPlaceRank(keys, 0);
    const middle = plannerPlaceRank(keys, 1);
    const afterRanked = plannerPlaceRank(keys, 2);
    expect(top.kind === "rank" && top.key < "b").toBe(true);
    expect(middle.kind === "rank" && middle.key > "b" && middle.key < "d").toBe(
      true,
    );
    expect(afterRanked.kind === "rank" && afterRanked.key > "d").toBe(true);
  });

  it("ranks a card put above everything when nothing is ranked yet", () => {
    expect(plannerPlaceRank([null, null], 0)).toMatchObject({ kind: "rank" });
  });

  it("re-spreads the column when the card above has no key", () => {
    const placed = plannerPlaceRank(["b", null, null], 2);
    expect(placed.kind).toBe("respread");
    expect(placed.kind === "respread" && placed.keys).toHaveLength(4);
  });

  it("re-spreads on equal neighbours and on a key past the length cap", () => {
    expect(plannerPlaceRank(["k", "k"], 1).kind).toBe("respread");
    const long = "1".repeat(plannerRankMaxLength);
    expect(plannerPlaceRank([long, `${long}1`], 1).kind).toBe("respread");
  });
});
