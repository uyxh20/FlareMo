import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type ExportChunk, streamExportData } from "../data-tasks";
import { exportData } from "../import-export/export-data";
import {
  type PlannerTestRuntime,
  plannerTestRuntime,
} from "../planner/test-support";
import { forkDataSources, forkUseVerdict } from "./data-sources";
import { FORK_EXPORT_TABLES, type ForkExportSection } from "./export";
import { markerOf, PROBES, resetProbes } from "./probes";

// The fork section of the personal export (fork/export.ts). data-reach.test.ts
// already checks each content table reaches the inline export; this file keeps
// the table list in step with the registry and checks the large, chunked export
// carries the same section.

describe("fork export: table list", () => {
  it("exports exactly the fork tables the registry marks for the export", () => {
    const registry = new Set(
      forkDataSources
        .filter(
          (source) =>
            source.owner === "fork" &&
            source.table !== "memos" &&
            forkUseVerdict(source.uses.userExport) === "yes",
        )
        .map((source) => source.table),
    );
    expect(Object.keys(FORK_EXPORT_TABLES).sort()).toEqual(
      [...registry].sort(),
    );
  });

  it("leaves no fork table as an export gap", () => {
    const gaps = forkDataSources.filter(
      (source) =>
        source.owner === "fork" &&
        forkUseVerdict(source.uses.userExport) === "gap",
    );
    expect(gaps.map((source) => source.id)).toEqual([]);
  });
});

let rt: PlannerTestRuntime;

describe("fork export: both export paths", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("fork-export-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await resetProbes(rt);
  });

  const probed = ["planner_goal", "planner_task_comment", "health_entry"];

  async function writeProbes() {
    for (const id of probed) {
      const probe = PROBES[id];
      if (!probe) throw new Error(`no probe for ${id}`);
      await probe({ rt, user: rt.user, marker: markerOf(id) });
      await probe({ rt, user: rt.other, marker: `Leak${markerOf(id)}` });
    }
  }

  it("puts the owner's rows, and only theirs, in the inline bundle", async () => {
    await writeProbes();
    const bundle = await exportData(rt.db, rt.user);
    const text = JSON.stringify(bundle.fork);
    for (const id of probed) expect(text).toContain(markerOf(id));
    expect(text).not.toMatch(/LeakZq/);
    expect(bundle.fork.counts.planner_goal).toBe(
      bundle.fork.tables.planner_goal.length,
    );
    expect(bundle.fork.counts.planner_goal).toBeGreaterThan(0);
    expect(Object.keys(bundle.fork.tables).sort()).toEqual(
      Object.keys(FORK_EXPORT_TABLES).sort(),
    );
  });

  it("puts the same section in the chunked export", async () => {
    await writeProbes();
    const chunks: ExportChunk[] = [];
    await streamExportData(rt.db, rt.user, (chunk) => {
      chunks.push(chunk);
    });
    const fork = chunks.filter((chunk) => chunk.kind === "fork");
    expect(fork).toHaveLength(1);
    const streamed = JSON.parse(fork[0]?.records ?? "") as ForkExportSection;
    const inline = (await exportData(rt.db, rt.user)).fork;
    expect(streamed).toEqual(inline);
  });

  it("still imports: the fork key is ignored by the import schema", async () => {
    const { importBundleSchema } = await import("@flaremo/contracts");
    const bundle = await exportData(rt.db, rt.user);
    const parsed = importBundleSchema.parse(JSON.parse(JSON.stringify(bundle)));
    expect(parsed).not.toHaveProperty("fork");
  });
});
