import type { Environment } from "@marcbachmann/cel-js";
import { MAX_MEMO_FILTER_AST_NODES } from "./limits";
import { getMemoFilterRegex } from "./regex";

/**
 * The shared CEL environment, built on first use instead of at module scope.
 *
 * `@marcbachmann/cel-js` is ~158 KiB of source across 14 files, and this
 * module is reachable from the `@flaremo/domain` barrel, which the Worker
 * entry imports for a handful of unrelated symbols. Because the barrel
 * re-exports runtime values, every consumer of it pulls this module in, so a
 * top-level `import { Environment }` put the whole parser in every isolate's
 * startup parse path for an environment that is only ever needed when a caller
 * actually passes a `filter=` expression.
 *
 * Breaking the barrel is the larger and better long-term fix, but it reaches
 * every route module. Deferring the leaf is contained and verifiable, and
 * matches how `articles.ts` defers `transliteration`. esbuild compiles
 * `import()` to a lazy `__esm` block, so cel-js genuinely does not execute
 * until a filter is actually compiled.
 *
 * Callers must therefore not touch this before they know a non-empty
 * expression exists: `compileMemoFilter(undefined)` must stay free of cel-js.
 *
 * The registration chain below is total — every variable name, type, and
 * function signature is a literal — so a construction failure is a programmer
 * error rather than a runtime condition, and memoizing the promise (rather
 * than retrying on rejection) matches that: ESM caches a failed module
 * evaluation anyway, so a retry could not recover.
 */
let environmentPromise: Promise<Environment> | undefined;

export function getMemoFilterEnvironment(): Promise<Environment> {
  // Memoize the promise, not the resolved value, so concurrent first-time
  // callers share one construction instead of racing. The environment is
  // immutable after registration and `parse()` is pure, so sharing it across
  // requests preserves the previous single-top-level-instance behaviour.
  environmentPromise ??= buildMemoFilterEnvironment();
  return environmentPromise;
}

async function buildMemoFilterEnvironment(): Promise<Environment> {
  const { Environment } = await import("@marcbachmann/cel-js");

  // Memos filters are user supplied. Keep the parser bounded even before the
  // domain-level node count check in `compile.ts` gets a chance to run.
  return (
    new Environment({
      limits: {
        maxAstNodes: MAX_MEMO_FILTER_AST_NODES,
        maxDepth: 64,
        maxListElements: 128,
        maxMapEntries: 128,
        maxCallArguments: 16,
      },
      unlistedVariablesAreDyn: false,
    })
      .registerVariable("content", "string")
      .registerVariable("creator", "string")
      .registerVariable("creator_id", "int")
      .registerVariable("created_ts", "google.protobuf.Timestamp")
      .registerVariable("updated_ts", "google.protobuf.Timestamp")
      .registerVariable("pinned", "bool")
      .registerVariable("visibility", "string")
      .registerVariable("state", "string")
      .registerVariable("tags", "list<string>")
      .registerVariable("tag", "string")
      .registerVariable("has_link", "bool")
      .registerVariable("has_task_list", "bool")
      .registerVariable("has_code", "bool")
      .registerVariable("has_incomplete_tasks", "bool")
      // AttachmentService uses the same CEL runtime with a smaller schema. Keep
      // these variables in the shared environment so both filters use identical
      // parsing, timestamp, duration, arithmetic, and string-method semantics.
      .registerVariable("filename", "string")
      .registerVariable("mime_type", "string")
      .registerVariable("create_time", "google.protobuf.Timestamp")
      // cel-js names CEL's dynamic/any type `dyn`.
      .registerVariable("memo_id", "dyn")
      .registerVariable("memo", "string")
      .registerVariable("now", "google.protobuf.Timestamp")
      .registerFunction(
        "flaremo_sets_contains(list<string>, list<string>): bool",
        (left: string[], right: string[]) =>
          distinctStrings(right).every((value) => left.includes(value)),
      )
      .registerFunction(
        "flaremo_sets_intersects(list<string>, list<string>): bool",
        (left: string[], right: string[]) =>
          distinctStrings(left).some((value) => right.includes(value)),
      )
      .registerFunction(
        "flaremo_sets_equivalent(list<string>, list<string>): bool",
        (left: string[], right: string[]) => {
          const leftSet = distinctStrings(left);
          const rightSet = distinctStrings(right);
          return (
            leftSet.length === rightSet.length &&
            leftSet.every((value) => rightSet.includes(value))
          );
        },
      )
      .registerFunction(
        "flaremo_tag_in(list<string>, list<string>): bool",
        (tags: string[], candidates: string[]) =>
          candidates.some((candidate) =>
            tags.some(
              (tag) => tag === candidate || tag.startsWith(`${candidate}/`),
            ),
          ),
      )
      .registerFunction(
        "string.flaremo_contains(string): bool",
        (left: string, right: string) =>
          left.toLowerCase().includes(right.toLowerCase()),
      )
      .registerFunction(
        "string.flaremo_startsWith(string): bool",
        (left: string, right: string) =>
          left.toLowerCase().startsWith(right.toLowerCase()),
      )
      .registerFunction(
        "string.flaremo_endsWith(string): bool",
        (left: string, right: string) =>
          left.toLowerCase().endsWith(right.toLowerCase()),
      )
      .registerFunction(
        "string.flaremo_matches(string): bool",
        (left: string, pattern: string) => {
          const regex = getMemoFilterRegex(pattern);
          return regex.test(left);
        },
      )
  );
}

function distinctStrings(values: string[]) {
  return [...new Set(values)];
}
