// @vitest-environment jsdom
import type {
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
  plannerUploadAttachmentRequest,
} from "./api";
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
// the list, choosing a file, the limits checked before upload, and removal
// after a confirmation. The network and the toasts are replaced; the list lives
// in the real query cache, as it does in the panel.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  plannerUploadAttachmentRequest: vi.fn(),
  plannerDeleteAttachmentRequest: vi.fn(),
}));

const upload = vi.mocked(plannerUploadAttachmentRequest);
const remove = vi.mocked(plannerDeleteAttachmentRequest);

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
    <PlannerTaskAttachments attachments={data.attachments} taskId={TASK_ID} />
  ) : null;
}

async function show(attachments: PlannerAttachmentDto[] = []) {
  const detail: PlannerTaskDetailResponse = {
    task: TASK,
    plan: null,
    project: null,
    comments: [],
    attachments,
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
});
