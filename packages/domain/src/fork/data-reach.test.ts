import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type PlannerTestRuntime,
  plannerTestRuntime,
} from "../planner/test-support";
import {
  type ForkConsumer,
  forkDataSources,
  forkUseReason,
  forkUseVerdict,
} from "./data-sources";
import {
  consumerTexts,
  MEASURED,
  markerOf,
  PROBES,
  resetProbes,
} from "./probes";

// Does each data source actually reach the places that use it? (fork-owned;
// docs/fork-data-sources.md)
//
// Each probe (probes.ts) writes one row whose text is a unique marker word into an
// otherwise empty database. Then the test builds, exactly as production does,
//
// - every prompt of the weekly review's look back (recap, coach, close, memo),
// - the look forward's goal check prompt,
// - the personal export bundle,
//
// and checks the marker is in each one marked `yes` in data-sources.ts and in no
// other. Nothing calls a model: the prompts are built and read as text.
//
// When this fails:
// - "expected to reach": the registry says yes but the code drops it. Fix the
//   code, or change the registry to gap with a reason.
// - "should not reach": the code now reads it. If that is on purpose, change the
//   registry to yes with what is read; if not, it is a leak to fix.
// - "has no probe": a content source was added. Write a probe for it in probes.ts.

let rt: PlannerTestRuntime;

describe("each data source reaches exactly the consumers the registry says", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("fork-data-reach-test");
  });

  afterAll(async () => {
    await rt.dispose();
  });

  beforeEach(async () => {
    await resetProbes(rt);
  });

  it("has a probe for every content source, and only for registry entries", () => {
    const content = forkDataSources
      .filter((source) => source.kind === "content")
      .map((source) => source.id);
    const missing = content.filter((id) => !PROBES[id]);
    expect(
      missing,
      "Content sources with no probe: add one to PROBES in probes.ts",
    ).toEqual([]);
    const known = new Set(forkDataSources.map((source) => source.id));
    expect(Object.keys(PROBES).filter((id) => !known.has(id))).toEqual([]);
  });

  for (const source of forkDataSources) {
    const probe = PROBES[source.id];
    if (!probe) continue;
    it(`${source.id}`, async () => {
      const marker = markerOf(source.id);
      await probe({ rt, user: rt.user, marker });
      // A probe that wrote nothing would pass every "should not reach".
      const rows = await rt.database
        .prepare(`SELECT * FROM ${source.table}`)
        .all();
      expect(
        JSON.stringify(rows.results),
        `the probe for ${source.id} must write its marker into ${source.table}`,
      ).toContain(marker);
      const texts = await consumerTexts(rt);
      for (const consumer of MEASURED) {
        const use = source.uses[consumer as ForkConsumer];
        const reaches = texts[consumer].includes(marker);
        const verdict = forkUseVerdict(use);
        expect(
          reaches,
          verdict === "yes"
            ? `${source.id} is expected to reach ${consumer} (${forkUseReason(use)}) but does not`
            : `${source.id} should not reach ${consumer} (registry: ${verdict}, "${forkUseReason(use)}") but it does. Update data-sources.ts if this is intended.`,
        ).toBe(verdict === "yes");
      }
    });
  }

  it("never hands one user's data to another user's review or export", async () => {
    for (const [id, probe] of Object.entries(PROBES)) {
      await probe({ rt, user: rt.other, marker: `Leak${markerOf(id)}` });
    }
    const texts = await consumerTexts(rt);
    for (const consumer of MEASURED) {
      expect(texts[consumer], consumer).not.toMatch(/LeakZq/);
    }
  });
});
