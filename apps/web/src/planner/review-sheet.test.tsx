// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { plannerGoalsStringsFor } from "./goals-strings";
import { PlannerMemoSheet } from "./review-sheet";
import {
  type PlannerTestMount,
  plannerTestClick,
  plannerTestMount,
  plannerTestType,
} from "./test-render";

// The summary memo sheet (review-sheet.tsx): a written memo is not saved until
// the owner presses Save, they can edit it first, and the text they save is the
// edited one.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

const strings = plannerGoalsStringsFor("en");
const MEMO = "# Week 41: October 5 - October 11, 2026\n\nA good week.";

let mounted: PlannerTestMount | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function Harness({
  initialSaved,
  onSave,
  onLookForward,
}: {
  initialSaved: boolean;
  onSave: (memo: string) => void;
  onLookForward: () => void;
}) {
  const [memo, setMemo] = useState(MEMO);
  const [saved, setSaved] = useState(initialSaved);
  return (
    <PlannerMemoSheet
      canWriteAgain={false}
      live={null}
      memo={memo}
      memoBy="model"
      open
      saveFailed={false}
      saved={saved}
      saving={false}
      stopped={false}
      strings={strings}
      week="2026-10-05"
      onClose={() => {}}
      onEdit={(next) => {
        setMemo(next);
        setSaved(false);
      }}
      onLookForward={onLookForward}
      onSave={() => {
        onSave(memo);
        setSaved(true);
      }}
      onStop={() => {}}
      onWriteAgain={() => {}}
    />
  );
}

const byTestId = (id: string) =>
  document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const button = (label: string) =>
  Array.from(document.body.querySelectorAll("button")).find(
    (node) => node.textContent === label,
  );

describe("the summary memo sheet", () => {
  it("waits for Save, and saves the text as edited", () => {
    const onSave = vi.fn();
    const onLookForward = vi.fn();
    mounted = plannerTestMount(
      <Harness
        initialSaved={false}
        onLookForward={onLookForward}
        onSave={onSave}
      />,
    );
    expect(byTestId("planner-memo-unsaved")?.textContent).toContain(
      "Not saved yet",
    );
    expect(button(strings.review.toLookForward)).toBeUndefined();

    plannerTestClick(byTestId("planner-memo-edit"));
    const editor = byTestId("planner-memo-editor") as HTMLTextAreaElement;
    expect(editor.value).toBe(MEMO);
    plannerTestType(editor, `${MEMO}\n\nEdited by hand.`);
    expect(onSave).not.toHaveBeenCalled();

    plannerTestClick(byTestId("planner-memo-save"));
    expect(onSave).toHaveBeenCalledWith(`${MEMO}\n\nEdited by hand.`);
    // Back in the preview, saved: the main button moves on to Look forward.
    expect(byTestId("planner-memo-editor")).toBeNull();
    expect(byTestId("planner-memo-unsaved")).toBeNull();
    plannerTestClick(button(strings.review.toLookForward));
    expect(onLookForward).toHaveBeenCalled();
  });

  it("asks to save again after a saved memo is edited", () => {
    mounted = plannerTestMount(
      <Harness initialSaved onLookForward={() => {}} onSave={() => {}} />,
    );
    expect(byTestId("planner-memo-save")).toBeNull();
    plannerTestClick(byTestId("planner-memo-edit"));
    plannerTestType(
      byTestId("planner-memo-editor") as HTMLTextAreaElement,
      "Changed.",
    );
    expect(byTestId("planner-memo-save")?.textContent).toBe(
      strings.review.memo.save,
    );
  });
});
