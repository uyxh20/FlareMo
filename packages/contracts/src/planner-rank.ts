// The cockpit board's manual order (fork-owned add-on,
// docs/planning-cockpit-implementation-plan.md, section 14). Shared by the
// domain service (which stores it) and the web board (which predicts it), so
// both sides compute the same keys.
//
// A rank is a fractional key: a string of base-62 digits `0-9A-Za-z` that sorts
// by plain code-unit comparison (`<`, never localeCompare). A new key can always
// be made between two others, so a move writes ONE row. A key never ends in the
// lowest digit "0" (that would equal the key without it), which is what leaves
// room below every key. Repeated inserts at one spot grow a key by about one
// digit per five inserts; past `plannerRankMaxLength` the column is re-spread
// (`plannerRankSpread`), which writes every row of that column once.
//
// The stored value is `<column>|<key>`. A stored value whose column is not the
// card's current column is stale (the task changed column through /projects or
// the API) and reads as "no rank".

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;

/** Keys longer than this are not made; the caller re-spreads the column instead. */
export const plannerRankMaxLength = 24;

/** The separator between the column and the key in a stored rank. */
const SEPARATOR = "|";

const KEY_PATTERN = /^[0-9A-Za-z]*[1-9A-Za-z]$/;

/** Whether a string is a well-formed key (non-empty, no trailing "0"). */
export function plannerIsRankKey(value: unknown): value is string {
  return typeof value === "string" && KEY_PATTERN.test(value);
}

const digitValue = (character: string | undefined): number =>
  character === undefined ? 0 : DIGITS.indexOf(character);

/** The midpoint of `a` and `b`; `a` may be "", `b` may be null for "no upper bound". */
function midpoint(a: string, b: string | null): string {
  if (b !== null) {
    // Skip the shared prefix (a is padded with the lowest digit).
    let shared = 0;
    while ((a[shared] ?? "0") === b[shared]) shared += 1;
    if (shared > 0) {
      return b.slice(0, shared) + midpoint(a.slice(shared), b.slice(shared));
    }
  }
  const low = digitValue(a[0]);
  const high = b === null ? BASE : digitValue(b[0]);
  if (high - low > 1) return DIGITS[Math.round((low + high) / 2)] as string;
  // Consecutive digits: either b is longer (its first digit is enough) or the
  // answer continues below `a`'s first digit.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return (DIGITS[low] as string) + midpoint(a.slice(1), null);
}

/**
 * A key strictly between `before` and `after`; null means the edge (no key on
 * that side). Throws a RangeError when `before >= after`, so a caller facing
 * duplicate or inverted keys can re-spread instead.
 */
export function plannerRankBetween(
  before: string | null,
  after: string | null,
): string {
  if (before !== null && !plannerIsRankKey(before)) {
    throw new RangeError("Malformed rank key");
  }
  if (after !== null && !plannerIsRankKey(after)) {
    throw new RangeError("Malformed rank key");
  }
  if (before !== null && after !== null && before >= after) {
    throw new RangeError("A rank key must come before the one after it");
  }
  return midpoint(before ?? "", after);
}

/**
 * `count` evenly spaced keys in ascending order, short and well inside the
 * length cap: the first rank of a column and a re-spread both use it.
 */
export function plannerRankSpread(count: number): string[] {
  if (count <= 0) return [];
  const width = count < 1800 ? 2 : 3;
  const total = BASE ** width;
  const step = Math.max(1, Math.floor(total / (count + 1)));
  const keys: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    let value = Math.min(index * step, total - 1);
    let key = "";
    for (let place = 0; place < width; place += 1) {
      key = (DIGITS[value % BASE] as string) + key;
      value = Math.floor(value / BASE);
    }
    keys.push(key.replace(/0+$/, ""));
  }
  return keys;
}

/** The stored form of a key in a column. */
export function plannerFormatBoardRank(column: string, key: string): string {
  return `${column}${SEPARATOR}${key}`;
}

/**
 * The key stored for a card, if it belongs to `column`; null for no rank, a
 * malformed value or a rank left over from another column.
 */
export function plannerParseBoardRank(
  stored: string | null | undefined,
  column: string,
): string | null {
  if (!stored) return null;
  const prefix = `${column}${SEPARATOR}`;
  if (!stored.startsWith(prefix)) return null;
  const key = stored.slice(prefix.length);
  return plannerIsRankKey(key) ? key : null;
}

/** Orders two cards of one column: ranked cards by key first, then `fallback`. */
export function plannerCompareRanked<T extends { id: string }>(
  rank: (card: T) => string | null,
  fallback: (left: T, right: T) => number,
): (left: T, right: T) => number {
  return (left, right) => {
    const a = rank(left);
    const b = rank(right);
    if (a !== null && b !== null) {
      return a < b ? -1 : a > b ? 1 : left.id < right.id ? -1 : 1;
    }
    if (a !== null) return -1;
    if (b !== null) return 1;
    return fallback(left, right);
  };
}

/**
 * Where a card lands among the others of a column, given the column's cards in
 * display order WITHOUT the moved card. The result is either the new key for the
 * moved card (`rank`) or, when a neighbour above it has no key to go after or the
 * keys cannot take another one, `respread`: every card gets a fresh key
 * (`keys[i]` for the i-th card of the final order, the moved card at `index`).
 */
export type PlannerRankPlacement =
  | { kind: "rank"; key: string }
  | { kind: "respread"; keys: string[] };

export function plannerPlaceRank(
  keys: readonly (string | null)[],
  index: number,
): PlannerRankPlacement {
  const above = index > 0 ? (keys[index - 1] ?? null) : null;
  const below = index < keys.length ? (keys[index] ?? null) : null;
  // A card above without a key means the ranked cards end before this spot:
  // there is nothing to go after. Everything gets a key once.
  if (index > 0 && above === null) {
    return { kind: "respread", keys: plannerRankSpread(keys.length + 1) };
  }
  try {
    // A card below without a key is fine: unranked cards sort after ranked ones.
    const key = plannerRankBetween(above, below);
    if (key.length <= plannerRankMaxLength) return { kind: "rank", key };
  } catch {
    // Equal or inverted keys fall through to the re-spread.
  }
  return { kind: "respread", keys: plannerRankSpread(keys.length + 1) };
}
