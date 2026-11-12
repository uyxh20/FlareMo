// @vitest-environment jsdom
import type { PlannerReviewResponse } from "@flaremo/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  plannerReadChatFileRequest,
  plannerUploadChatFileRequest,
} from "./api";
import { plannerGoalsStringsFor } from "./goals-strings";
import { type PlannerBackActions, PlannerLookBack } from "./review-back";
import { plannerFallbackDrafts, plannerNewBackState } from "./review-model";
import { type PlannerTestMount, plannerTestMount } from "./test-render";

// Files in the review (fork, docs/fork-task-attachments.md): with the coach
// on, the answer box takes a dropped, pasted or picked file, reads it at once
// and sends its text with the next answer. The network is replaced.

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  plannerUploadChatFileRequest: vi.fn(),
  plannerPutChatFileCopyRequest: vi.fn(),
  plannerReadChatFileRequest: vi.fn(),
}));
vi.mock("./attachment-reading-copy", () => ({
  plannerMakeReadingCopy: vi.fn(async () => null),
}));

const upload = vi.mocked(plannerUploadChatFileRequest);
const read = vi.mocked(plannerReadChatFileRequest);

const REVIEW = {
  today: "2026-10-11",
  review_week: "2026-10-05",
  plan_week: "2026-10-12",
  state: null,
  look_back_done_at: null,
  look_forward_done_at: null,
  last_question: null,
  week_goals: [],
  plan_goals: [],
  flags: [],
  flag_goals: [],
  scores: [],
  week: null,
  summary: null,
  suggested_goals: {},
  ai: true,
  reads: { entries: 0, health_rows: 0, tasks_done: 0, goals: 0 },
} as unknown as PlannerReviewResponse;

const strings = plannerGoalsStringsFor("en-US");
let mounted: PlannerTestMount | null = null;
let answer: ReturnType<typeof vi.fn>;

function show(coach: boolean) {
  answer = vi.fn();
  const back = { ...plannerNewBackState(REVIEW), stage: "p" as const, pi: 0 };
  const actions = {
    start: vi.fn(),
    answer,
    next: vi.fn(),
    goalResult: vi.fn(),
    stepScore: vi.fn(),
    keepScores: vi.fn(),
    writeMemo: vi.fn(),
    openMemo: vi.fn(),
    lookForward: vi.fn(),
  } as unknown as PlannerBackActions;
  mounted = plannerTestMount(
    <PlannerLookBack
      actions={actions}
      back={back}
      busy={false}
      coach={coach}
      done={false}
      drafts={plannerFallbackDrafts(REVIEW)}
      live={null}
      review={REVIEW}
      strings={strings}
      writing={false}
    />,
  );
  return mounted.container;
}

async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function paste(box: HTMLTextAreaElement, files: File[]) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files } });
  await act(async () => {
    box.dispatchEvent(event);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  upload.mockResolvedValue({
    file: { id: "f-1", filename: "run.pdf" },
  } as Awaited<ReturnType<typeof plannerUploadChatFileRequest>>);
  read.mockResolvedValue({
    text: "Text of run.pdf: 10 km.",
  } as Awaited<ReturnType<typeof plannerReadChatFileRequest>>);
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe("files in the review's answer box", () => {
  it("reads a pasted file and sends its text with the answer", async () => {
    const container = show(true);
    const button = container.querySelector(
      '[data-testid="planner-review-upload"]',
    ) as HTMLButtonElement | null;
    expect(button?.getAttribute("aria-label")).toBe("Attach a file");
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe("Upload");
    const box = container.querySelector(
      '[data-testid="planner-review-composer"]',
    ) as HTMLTextAreaElement;
    await paste(box, [
      new File(["%PDF"], "run.pdf", { type: "application/pdf" }),
    ]);
    await settle();
    const list = container.querySelector(
      '[data-testid="planner-review-files"]',
    );
    expect(list?.textContent).toContain("Goes with your answer");
    expect(list?.textContent).toContain("run.pdf · read");

    // A file alone is an answer too.
    const send = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Send",
    ) as HTMLButtonElement;
    expect(send.disabled).toBe(false);
    await act(async () => {
      send.click();
    });
    expect(answer).toHaveBeenCalledWith("", [
      { filename: "run.pdf", text: "Text of run.pdf: 10 km." },
    ]);
    expect(
      container.querySelector('[data-testid="planner-review-files"]'),
    ).toBeNull();
  });

  it("takes no file when no coach replies", async () => {
    const container = show(false);
    expect(container.querySelector('[aria-label="Attach a file"]')).toBeNull();
    // The Upload button stays in view, greyed out, saying where files go.
    const button = container.querySelector(
      '[data-testid="planner-review-upload"]',
    ) as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe("Upload");
    const box = container.querySelector(
      '[data-testid="planner-review-composer"]',
    ) as HTMLTextAreaElement;
    await paste(box, [new File(["x"], "shot.png", { type: "image/png" })]);
    expect(upload).not.toHaveBeenCalled();
  });
});
