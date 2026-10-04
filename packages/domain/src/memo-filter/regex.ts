import { ValidationError } from "../errors";
import {
  MAX_MEMO_FILTER_REGEX_CACHE_ENTRIES,
  MAX_MEMO_FILTER_REGEX_LENGTH,
} from "./limits";

export const memoFilterRegexCache = new Map<string, RegExp>();

export function validateRegexPattern(pattern: string) {
  if (pattern.length > MAX_MEMO_FILTER_REGEX_LENGTH) {
    rejectUnsupported("regex literal is too long");
  }
  if (/\\(?:[1-9]\d*|k<)|\(\?/.test(pattern)) {
    rejectUnsupported("regex uses an unsupported construct");
  }
  if (/\((?:[^()\\]|\\.)*[+*{](?:[^()\\]|\\.)*\)[+*{]/.test(pattern)) {
    rejectUnsupported("regex contains nested quantifiers");
  }
  // JS RegExp has no step budget, so a user-supplied pattern evaluated
  // against 100k-char content must be statically linear. Reject the classic
  // super-linear shapes: a quantifier applied to a group that itself
  // contains a quantifier or an alternation, e.g. `(a|aa)+$`, `(a+)+`.
  assertRegexLinearSafety(pattern);
  if (memoFilterRegexCache.has(pattern)) return;
  let regex: RegExp;
  try {
    regex = new RegExp(pattern);
  } catch {
    rejectUnsupported("regex is invalid");
  }
  if (memoFilterRegexCache.size >= MAX_MEMO_FILTER_REGEX_CACHE_ENTRIES) {
    const oldest = memoFilterRegexCache.keys().next().value;
    if (oldest !== undefined) memoFilterRegexCache.delete(oldest);
  }
  memoFilterRegexCache.set(pattern, regex);
}

type RegexGroupFrame = {
  alternation: boolean;
  hasInnerQuantifier: boolean;
};

/**
 * Walk the pattern tracking group depth. A quantifier directly after a group
 * is rejected when the group contains an alternation or any inner quantifier,
 * because those shapes decompose a match position in exponentially many ways
 * (catastrophic backtracking). The scan is conservative: it may reject a few
 * linear patterns, but never accepts a super-linear one it was built to
 * catch. Compile errors are handled by the `new RegExp` check that follows.
 */
function assertRegexLinearSafety(pattern: string) {
  const stack: RegexGroupFrame[] = [];
  let index = 0;
  while (index < pattern.length) {
    const character = pattern[index] as string;
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "[") {
      index += 1;
      while (index < pattern.length && pattern[index] !== "]") {
        if (pattern[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      continue;
    }
    if (character === "(") {
      stack.push({ alternation: false, hasInnerQuantifier: false });
      index += 1;
      continue;
    }
    if (character === ")") {
      const frame = stack.pop();
      if (!frame) break;
      if (regexHasQuantifierAt(pattern, index + 1)) {
        if (frame.alternation || frame.hasInnerQuantifier) {
          rejectUnsupported("regex contains nested quantifiers");
        }
      }
      index += 1;
      continue;
    }
    if (character === "|" && stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame) frame.alternation = true;
      index += 1;
      continue;
    }
    if (regexHasQuantifierAt(pattern, index)) {
      if (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame) frame.hasInnerQuantifier = true;
      }
      index = regexSkipQuantifier(pattern, index);
      continue;
    }
    index += 1;
  }
}

/** Whether an unbounded-or-bounded quantifier (`*`, `+`, `?`, `{…}`) starts at
 * `index`. Even bounded repetition inside a quantified group can decompose
 * exponentially, so `{…}` counts too. */
function regexHasQuantifierAt(pattern: string, index: number): boolean {
  const character = pattern[index];
  return character === "*" || character === "+" || character === "?";
}

/** Consume a full quantifier expression starting at `index`, including a
 * trailing lazy/possessive marker. */
function regexSkipQuantifier(pattern: string, index: number): number {
  let cursor = index + 1;
  if (pattern[cursor] === "{") {
    while (cursor < pattern.length && pattern[cursor] !== "}") cursor += 1;
    cursor += 1;
  }
  if (pattern[cursor] === "?" || pattern[cursor] === "+") cursor += 1;
  return cursor;
}

export function getMemoFilterRegex(pattern: string) {
  const cached = memoFilterRegexCache.get(pattern);
  if (cached) return cached;
  validateRegexPattern(pattern);
  const compiled = memoFilterRegexCache.get(pattern);
  if (!compiled) throw new Error("Memos filter regex was not compiled");
  return compiled;
}

function rejectUnsupported(message: string): never {
  throw new ValidationError(`Invalid Memos CEL filter: ${message}`);
}
