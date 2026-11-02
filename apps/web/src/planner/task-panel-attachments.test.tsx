// @vitest-environment jsdom
import type {
  PlannerAgentActionDto,
  PlannerAttachmentDto,
  PlannerTaskDetailResponse,
  TaskDto,
} from "@flaremo/contracts";
import { QueryClient, useQuery } from "@tanstack/react-query";
import { act } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import {
  plannerDeleteAttachmentRequest,
  plannerReadAttachmentRequest,
  plannerSetAttachmentSettingsRequest,
  plannerUploadAttachmentRequest,
} from "./api";
import { plannerSettleActionRequest } from "./ask-api";
import { plannerQueryKeys } from "./query-keys";
import {
  PlannerTaskAttachments,
  plannerAttachmentKind,
} from "./task-panel-attachments";
import {
  type PlannerTestMount,
  plannerTestClick,
  plannerTestMount,
} from "./test-render";

// The task panel's files (fork-owned add-on, docs/fork-task-attachments.md):
// the list, choosing a file, the limits checked before upload, removal after a
// confirmation, and (phase 2) each file's reading state, the proposed comment
// under it, "Read again" and the task's Store-only switch. The network and the
// toasts are replaced; the list lives in the real query cache, as in the panel.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  plannerUploadAttachmentRequest: vi.fn(),
  plannerDeleteAttachmentRequest: vi.fn(),
  plannerReadAttachmentRequest: vi.fn(),
  plannerSetAttachmentSettingsRequest: vi.fn(),
}));
vi.mock("./ask-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ask-api")>()),
  plannerSettleActionRequest: vi.fn(),
}));

const upload = vi.mocked(plannerUploadAttachmentRequest);
const remove = vi.mocked(plannerDeleteAttachmentRequest);
const read = vi.mocked(plannerReadAttachmentRequest);
const settings = vi.mocked(plannerSetAttachmentSettingsRequest);
const settleAction = vi.mocked(plannerSettleActionRequest);

const TASK_ID = "tasks/t1";

const TASK: TaskDto = {
  id: TASK_ID,
  project_id: null,
  source_memo_id: null,
  title: "Renew the flat insurance",
  notes: null,
  status: "todo",
  priority: "none",
  due_at: null,
  sort_order: 0,
  completed_at: null,
  deleted_at: null,
  created_at: "2026-10-01T08:00:00.000Z",
  updated_at: "2026-10-01T08:00:00.000Z",
};

function file(
  id: string,
  filename: string,
  overrides: Partial<PlannerAttachmentDto> = {},
): PlannerAttachmentDto {
  return {
    id,
    task_id: TASK_ID,
    filename,
    content_type: "application/pdf",
    size: 1_258_291,
    read_state: "stored",
    action_id: null,
    proposal: null,
    created_at: "2026-11-01T09:00:00.000Z",
    url: `/api/app/planner/tasks/t1/attachments/${id}/${encodeURIComponent(filename)}`,
    ...overrides,
  };
}

const QUOTE = file("a-1", "insurance-quote-2025.pdf");
const SHOT = file("a-2", "screenshot.png", {
  content_type: "image/png",
  size: 2_200_000,
});

function proposal(
  state: PlannerAgentActionDto["state"] = "open",
): PlannerAgentActionDto {
  return {
    id: "act-1",
    kind: "comment_new",
    task_id: TASK_ID,
    field: null,
    change: {
      body: "Quote: EUR 212 a year, cover from 1 January.",
      attachment_id: "a-1",
      filename: "insurance-quote-2025.pdf",
    },
    why: "Read from insurance-quote-2025.pdf",
    state,
    landed_id: state === "accepted" ? "cmt-1" : null,
    entry_id: null,
    created_at: "2026-11-01T09:01:00.000Z",
  };
}

let mounted: PlannerTestMount | undefined;
let queryClient: QueryClient;

async function settle(rounds = 3) {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  queryClient.clear();
  for (const leftover of Array.from(document.body.children)) leftover.remove();
});

function Section() {
  const { data } = useQuery({
    queryKey: plannerQueryKeys.detail(TASK_ID),
    queryFn: (): Promise<PlannerTaskDetailResponse> =>
      Promise.reject(new Error("The test seeds this.")),
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data ? (
    <PlannerTaskAttachments
      attachments={data.attachments}
      filesRead={data.files_read}
      readsEnabled={readsEnabled}
      taskId={TASK_ID}
      today="2026-11-02"
    />
  ) : null;
}

let readsEnabled = true;

async function show(
  attachments: PlannerAttachmentDto[] = [],
  options: { filesRead?: boolean; readsEnabled?: boolean } = {},
) {
  readsEnabled = options.readsEnabled ?? true;
  const detail: PlannerTaskDetailResponse = {
    task: TASK,
    plan: null,
    project: null,
    comments: [],
    attachments,
    files_read: options.filesRead ?? true,
  };
  queryClient.setQueryData(plannerQueryKeys.detail(TASK_ID), detail);
  mounted = plannerTestMount(<Section />, { queryClient });
  await settle(1);
  return mounted.container;
}

const cached = () =>
  queryClient.getQueryData<PlannerTaskDetailResponse>(
    plannerQueryKeys.detail(TASK_ID),
  )?.attachments ?? [];

const items = (container: HTMLElement) =>
  Array.from(
    container.querySelectorAll<HTMLElement>(
      '[data-testid="planner-attachment"]',
    ),
  );

/** Puts files in the hidden picker and fires its change, as choosing them does. */
async function choose(container: HTMLElement, files: File[]) {
  const input = container.querySelector<HTMLInputElement>(
    '[data-testid="planner-attachment-input"]',
  );
  if (!input) throw new Error("No file input");
  Object.defineProperty(input, "files", { value: files, configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("plannerAttachmentKind", () => {
  it("names a file by its extension, else by its type", () => {
    expect(plannerAttachmentKind(QUOTE)).toBe("PDF");
    expect(plannerAttachmentKind(SHOT)).toBe("PNG");
    expect(
      plannerAttachmentKind({ filename: "README", content_type: "text/plain" }),
    ).toBe("TEXT");
    expect(
      plannerAttachmentKind({ filename: "photo", content_type: "image/jpeg" }),
    ).toBe("IMAGE");
    expect(
      plannerAttachmentKind({
        filename: "archive.tar.gz",
        content_type: null,
      }),
    ).toBe("GZ");
    expect(plannerAttachmentKind({ filename: "x", content_type: null })).toBe(
      "FILE",
    );
  });
});

describe("PlannerTaskAttachments", () => {
  it("lists the files with their kind, size and state, a picture for an image, and the count", async () => {
    const container = await show([QUOTE, SHOT]);
    const rows = items(container);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("insurance-quote-2025.pdf");
    expect(rows[0]?.textContent).toContain("PDF · 1.2 MB · stored");
    expect(rows[0]?.querySelector("img")).toBeNull();
    expect(rows[0]?.textContent).toContain("Read");
    expect(rows[1]?.querySelector("img")?.getAttribute("src")).toBe(SHOT.url);
    expect(container.querySelector("h3")?.textContent).toContain("2 of 10");
    expect(
      container.querySelector<HTMLAnchorElement>("a[title='Open file']")?.href,
    ).toContain(QUOTE.url);
  });

  it("says when there is nothing, and offers the picker", async () => {
    const container = await show([]);
    expect(container.textContent).toContain("No files yet.");
    expect(container.textContent).toContain("choose files");
  });

  it("uploads a chosen file, shows it on its way, and adds it to the cached detail", async () => {
    const container = await show([QUOTE]);
    upload.mockResolvedValueOnce({ attachment: SHOT });

    await choose(container, [
      new File([new Uint8Array(8)], "screenshot.png", { type: "image/png" }),
    ]);

    expect(upload).toHaveBeenCalledWith(TASK_ID, expect.any(File));
    await settle();
    expect(cached().map((entry) => entry.id)).toEqual(["a-1", "a-2"]);
    expect(items(container)).toHaveLength(2);
    expect(
      container.querySelector('[data-testid="planner-attachment-uploading"]'),
    ).toBeNull();
  });

  it("refuses a file over 10 MB and an eleventh file here, without asking the server", async () => {
    const ten = Array.from({ length: 10 }, (_, n) =>
      file(`f-${n}`, `f${n}.txt`),
    );
    const container = await show(ten);
    expect(container.textContent).not.toContain("choose files");

    await choose(container, [new File(["x"], "eleventh.txt")]);
    expect(upload).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "A task can hold at most 10 files",
      expect.anything(),
    );

    mounted?.unmount();
    const fresh = await show([]);
    const big = new File([new Uint8Array(1)], "big.bin");
    Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });
    await choose(fresh, [big]);
    expect(upload).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      "big.bin is over 10.0 MB",
      expect.anything(),
    );
  });

  it("says so in a toast when the server refuses an upload, and keeps the list as it was", async () => {
    const container = await show([QUOTE]);
    upload.mockRejectedValueOnce(new ApiError("Too many requests", 429));

    await choose(container, [new File(["x"], "late.txt")]);
    await settle();

    expect(cached().map((entry) => entry.id)).toEqual(["a-1"]);
    expect(items(container)).toHaveLength(1);
    expect(toast.error).toHaveBeenCalled();
  });

  it("removes a file after the confirmation, and puts it back when the server refuses", async () => {
    const container = await show([QUOTE, SHOT]);
    remove.mockResolvedValueOnce({ ok: true });

    plannerTestClick(
      items(container)[0]?.querySelector("button[aria-label='Remove file']"),
    );
    await settle(1);
    const confirm = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "Remove",
    );
    expect(document.body.textContent).toContain("Remove this file?");
    plannerTestClick(confirm);
    await settle();

    expect(remove).toHaveBeenCalledWith("a-1");
    expect(cached().map((entry) => entry.id)).toEqual(["a-2"]);
    expect(items(container)).toHaveLength(1);

    // A refusal: the detail is asked for again; here that fails, so the cache
    // keeps the optimistic list and the toast says why.
    remove.mockRejectedValueOnce(new ApiError("Not found", 404));
    plannerTestClick(
      items(container)[0]?.querySelector("button[aria-label='Remove file']"),
    );
    await settle(1);
    plannerTestClick(
      Array.from(document.body.querySelectorAll("button")).find(
        (button) => button.textContent === "Remove",
      ),
    );
    await settle();
    expect(toast.error).toHaveBeenCalledWith("Not found", expect.anything());
  });

  it("says each file's reading state in plain words, and shows the proposed comment under a read file", async () => {
    const container = await show([
      file("p", "p.pdf", { read_state: "pending" }),
      file("r", "r.pdf", {
        read_state: "read",
        action_id: "act-1",
        proposal: proposal("open"),
      }),
      file("a", "a.pdf", {
        read_state: "read",
        action_id: "act-1",
        proposal: proposal("accepted"),
      }),
      file("f", "f.bin", { read_state: "failed" }),
      file("c", "c.pdf", { read_state: "capped" }),
      file("s", "s.pdf", { read_state: "skipped" }),
    ]);
    const text = items(container).map((row) => row.textContent ?? "");
    expect(text[0]).toContain("reading…");
    expect(text[0]).not.toContain("Read again");
    expect(text[1]).toContain("comment proposed");
    expect(text[1]).toContain("Proposed comment");
    expect(text[1]).toContain("Quote: EUR 212 a year");
    expect(text[1]).toContain("Accept");
    expect(text[1]).not.toContain("Read again");
    expect(text[2]).toContain("comment added");
    expect(text[3]).toContain("not read: unreadable");
    expect(text[3]).toContain("Read again");
    expect(text[4]).toContain("not read: cap reached");
    expect(text[5]).toContain("stored only");
    expect(
      container.querySelectorAll('[data-testid="planner-proposal"]'),
    ).toHaveLength(2);
    expect(
      container.querySelector('[data-testid="planner-attachments-store-only"]'),
    ).not.toBeNull();
  });

  it("offers neither reading nor the switch when this deployment cannot read files", async () => {
    const container = await show([QUOTE], { readsEnabled: false });
    expect(container.textContent).not.toContain("Read");
    expect(
      container.querySelector('[data-testid="planner-attachments-store-only"]'),
    ).toBeNull();
  });

  it("asks for a read again, shows the file reading meanwhile, and takes the server's answer", async () => {
    const failed = file("f", "f.pdf", { read_state: "failed" });
    const container = await show([failed]);
    let answer: (value: { attachment: PlannerAttachmentDto }) => void =
      () => {};
    read.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );

    plannerTestClick(
      Array.from(items(container)[0]?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "Read again",
      ),
    );
    await settle(1);
    expect(read).toHaveBeenCalledWith("f");
    expect(items(container)[0]?.dataset.state).toBe("pending");
    expect(items(container)[0]?.textContent).toContain("reading…");

    answer({ attachment: { ...failed, read_state: "pending" } });
    await settle();
    expect(cached()[0]?.read_state).toBe("pending");

    // A refusal puts the file back as it was and says why.
    read.mockRejectedValueOnce(new ApiError("This file is being read.", 409));
    queryClient.setQueryData<PlannerTaskDetailResponse>(
      plannerQueryKeys.detail(TASK_ID),
      (detail) => (detail ? { ...detail, attachments: [failed] } : detail),
    );
    await settle(1);
    plannerTestClick(
      Array.from(items(container)[0]?.querySelectorAll("button") ?? []).find(
        (button) => button.textContent === "Read again",
      ),
    );
    await settle();
    expect(cached()[0]?.read_state).toBe("failed");
    expect(toast.error).toHaveBeenCalledWith(
      "This file is being read.",
      expect.anything(),
    );
  });

  it("accepting the card under a file marks the comment as added", async () => {
    const container = await show([
      file("r", "r.pdf", {
        read_state: "read",
        action_id: "act-1",
        proposal: proposal("open"),
      }),
    ]);
    settleAction.mockResolvedValueOnce({ action: proposal("accepted") });

    plannerTestClick(
      Array.from(container.querySelectorAll("button")).find(
        (button) => button.textContent === "Accept",
      ),
    );
    await settle();

    expect(settleAction).toHaveBeenCalledWith("act-1", {
      state: "accepted",
      today: "2026-11-02",
    });
    expect(cached()[0]?.proposal?.state).toBe("accepted");
    expect(items(container)[0]?.textContent).toContain("comment added");
  });

  it("the Store-only switch keeps the task's files unread, and goes back when the server refuses", async () => {
    const container = await show([QUOTE]);
    settings.mockResolvedValueOnce({ files_read: false });
    const toggle = () =>
      plannerTestClick(
        container.querySelector(
          '[data-testid="planner-attachments-store-only"]',
        ),
      );

    toggle();
    await settle();
    expect(settings).toHaveBeenCalledWith(TASK_ID, false);
    expect(
      queryClient.getQueryData<PlannerTaskDetailResponse>(
        plannerQueryKeys.detail(TASK_ID),
      )?.files_read,
    ).toBe(false);
    expect(
      container
        .querySelector('[data-testid="planner-attachments-store-only"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");

    settings.mockRejectedValueOnce(new ApiError("Too many requests", 429));
    toggle();
    await settle();
    expect(settings).toHaveBeenLastCalledWith(TASK_ID, true);
    expect(
      queryClient.getQueryData<PlannerTaskDetailResponse>(
        plannerQueryKeys.detail(TASK_ID),
      )?.files_read,
    ).toBe(false);
    expect(toast.error).toHaveBeenCalled();
  });
});
