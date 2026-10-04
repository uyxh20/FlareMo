import { applyFlaremoMigrations, createDb } from "@flaremo/db";
import { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamViewer } from "./team-permissions";
import { ensureTeamOwner } from "./test-support";

/**
 * Proves *when* the CEL runtime is actually reached.
 *
 * `@marcbachmann/cel-js` is loaded with a dynamic `import()` from
 * `memo-filter/environment.ts` so it leaves the Worker's static startup graph.
 * That win only materialises if requests passing no `filter=` never reach the
 * import, since unfiltered list traffic is the overwhelming majority.
 *
 * The observable is the number of `Environment` instances built: the loader does
 * `await import(...)` and `new Environment(...)` back to back, so for any given
 * module graph "an environment was built" and "cel-js was loaded" are the same
 * event. Counting constructions (rather than module-factory invocations) is what
 * makes the counter meaningful per test, because `vi.resetModules()` hands each
 * test a fresh `environment.ts` while the mock factory itself still runs only
 * once per file.
 */
const cel = vi.hoisted(() => ({ builds: 0 }));

vi.mock("@marcbachmann/cel-js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@marcbachmann/cel-js")>();
  class CountingEnvironment extends actual.Environment {
    constructor(options: ConstructorParameters<typeof actual.Environment>[0]) {
      super(options);
      cel.builds += 1;
    }
  }
  return { ...actual, Environment: CountingEnvironment };
});

// A fresh module registry per test is required: the environment is memoized in
// a module-level promise, so without a reset the first test to compile a filter
// would mask every later one.
beforeEach(() => {
  cel.builds = 0;
  vi.resetModules();
});

describe("Memos CEL filter lazy CEL runtime", () => {
  it("never loads cel-js when no filter expression is supplied", async () => {
    const { compileMemoFilter } = await import("./memo-filter");

    // Exactly what listMemosForViewer does for a request without `filter=`
    // (it calls compileMemoFilter(query.filter)).
    await expect(compileMemoFilter(undefined)).resolves.toBeUndefined();
    await expect(compileMemoFilter("")).resolves.toBeUndefined();
    await expect(compileMemoFilter("   \n\t ")).resolves.toBeUndefined();
    expect(cel.builds).toBe(0);
  });

  it("keeps cel-js unloaded for the attachment list path without a filter", async () => {
    const { compileAttachmentFilter } = await import("./memo-filter");

    await expect(compileAttachmentFilter(undefined)).resolves.toBeUndefined();
    await expect(compileAttachmentFilter("")).resolves.toBeUndefined();
    expect(cel.builds).toBe(0);
  });

  it("keeps cel-js unloaded for the cheap pre-parse rejections", async () => {
    const { compileMemoFilter } = await import("./memo-filter");

    // Oversized input is rejected on length alone, before the parser.
    await expect(compileMemoFilter("x".repeat(4_097))).rejects.toThrow(
      "Memos filter is too long",
    );
    // Reserved helper names are rejected by the scanner, not by CEL parsing.
    await expect(
      compileMemoFilter("flaremo_contains(content)"),
    ).rejects.toThrow("reserved implementation helper is not public");
    expect(cel.builds).toBe(0);
  });

  it("loads cel-js once on the first real expression, then reuses it", async () => {
    const { compileMemoFilter } = await import("./memo-filter");
    expect(cel.builds).toBe(0);

    const first = await compileMemoFilter("pinned == true");
    expect(cel.builds).toBe(1);
    expect(first?.completeInSql).toBe(true);

    // Memoized environment: later filters must not rebuild it.
    await compileMemoFilter('content.contains("roadmap")');
    await compileMemoFilter("size(tags) == 2");
    expect(cel.builds).toBe(1);
  });

  it("shares one environment across concurrent first-time compiles", async () => {
    const { compileMemoFilter } = await import("./memo-filter");

    const compiled = await Promise.all([
      compileMemoFilter("pinned == true"),
      compileMemoFilter("pinned == false"),
      compileMemoFilter('state == "NORMAL"'),
    ]);
    // Racy construction would show up as >1 here.
    expect(cel.builds).toBe(1);
    expect(compiled.map((c) => c?.completeInSql)).toEqual([true, true, true]);
  });
});

describe("listMemosForViewer CEL runtime loading", () => {
  let mf: Miniflare;
  let db: ReturnType<typeof createDb>;
  let owner: TeamViewer;

  beforeEach(async () => {
    mf = new Miniflare({
      script: "export default { fetch() { return new Response('ok') } }",
      modules: true,
      compatibilityDate: "2026-07-10",
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: { DB: "flaremo-cel-lazy-test" },
    });
    const database = await mf.getD1Database("DB");
    db = createDb(database);
    await applyFlaremoMigrations(database);
    owner = await ensureTeamOwner(db);
    const { createMemo } = await import("./memos");
    await createMemo(db, owner, {
      content: "roadmap for urgent launch",
      visibility: "public",
      source: "web",
    });
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("lists memos without touching cel-js when filter is absent", async () => {
    const { listMemosForViewer } = await import("./memos");
    const result = await listMemosForViewer(db, owner, {
      page_size: 10,
      order_by: "created_at desc",
      include_deleted: false,
    });
    expect(result.memos.length).toBe(1);
    expect(cel.builds).toBe(0);
  });

  it("loads cel-js when filter is present, and still filters correctly", async () => {
    const { listMemosForViewer } = await import("./memos");
    const result = await listMemosForViewer(db, owner, {
      page_size: 10,
      order_by: "created_at desc",
      include_deleted: false,
      filter: 'content.contains("roadmap")',
    });
    expect(cel.builds).toBe(1);
    expect(result.memos.length).toBe(1);

    const miss = await listMemosForViewer(db, owner, {
      page_size: 10,
      order_by: "created_at desc",
      include_deleted: false,
      filter: 'content.contains("nonexistent")',
    });
    expect(miss.memos.length).toBe(0);
    // Still memoized after the first load.
    expect(cel.builds).toBe(1);
  });
});
