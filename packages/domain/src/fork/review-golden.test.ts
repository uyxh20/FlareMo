import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { plannerCheckMessages, plannerReviewContextBlock } from "../planner";
import {
  type PlannerTestRuntime,
  plannerTestRuntime,
} from "../planner/test-support";
import { markerOf, PROBES, resetProbes, reviewContextFor } from "./probes";

// What the weekly review's model is shown, word for word (fork-owned;
// docs/fork-data-sources.md).
//
// Every probe writes its marker into one database, then the review's context
// block (the part every look back prompt ends with) and the look forward's goal
// check are saved to __snapshots__/. Reading those files shows exactly which
// data the model sees and how it is laid out; a change to what the review reads
// shows up as a diff in them. After a deliberate change, refresh them with
//
//   pnpm exec vitest run packages/domain/src/fork/review-golden.test.ts -u
//
// and read the diff before committing it.

let rt: PlannerTestRuntime;

describe("what the weekly review's model sees", () => {
  beforeAll(async () => {
    rt = await plannerTestRuntime("fork-review-golden-test");
    await resetProbes(rt);
    for (const [id, probe] of Object.entries(PROBES)) {
      await probe({ rt, user: rt.user, marker: markerOf(id) });
    }
  });

  afterAll(async () => {
    await rt.dispose();
  });

  it("look back: the context block", async () => {
    const context = await reviewContextFor(rt);
    await expect(plannerReviewContextBlock(context)).toMatchFileSnapshot(
      "__snapshots__/look-back-context.txt",
    );
  });

  it("look forward: the goal check", async () => {
    const context = await reviewContextFor(rt);
    const messages = plannerCheckMessages(
      context,
      [
        {
          id: "g1",
          pillar: "work",
          title: "Ship the beta",
          tasks: ["Write docs"],
        },
      ],
      [],
    );
    await expect(
      messages.map((m) => `--- ${m.role}\n${m.content}`).join("\n\n"),
    ).toMatchFileSnapshot("__snapshots__/look-forward-check.txt");
  });
});
