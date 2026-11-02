// @vitest-environment jsdom
import type {
  PlannerAskResponse,
  PlannerAttachmentDto,
  PlannerTaskDetailResponse,
  TaskDto,
} from "@flaremo/contracts";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plannerUploadAttachmentRequest } from "./api";
import { plannerFetchAsk } from "./ask-api";
import { PlannerAskChat } from "./ask-chat";
import { plannerQueryKeys } from "./query-keys";
import { type PlannerTestMount, plannerTestMount } from "./test-render";

// A task's chat takes files (docs/fork-task-attachments.md, phase 3): a drop on
// the chat or a paste into the question box is the panel's upload, and the
// files from this chat are listed above the question box with their state.
// The network is replaced; the detail lives in the real query cache.

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  plannerUploadAttachmentRequest: vi.fn(),
  plannerFetchTaskDetail: vi.fn(() => new Promise(() => {})),
}));
vi.mock("./ask-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ask-api")>()),
  plannerFetchAsk: vi.fn(),
}));

const upload = vi.mocked(plannerUploadAttachmentRequest);
const fetchAsk = vi.mocked(plannerFetchAsk);

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
const IDLE: PlannerAskResponse = {
  conversation: null,
  status: "idle",
  messages: [],
  actions: [],
} as unknown as PlannerAskResponse;

const QUOTE: PlannerAttachmentDto = {
  id: "a-1",
  task_id: TASK_ID,
  filename: "quote.pdf",
  content_type: "application/pdf",
  size: 1234,
  read_state: "pending",
  action_id: null,
  proposal: null,
  created_at: "2026-11-01T09:00:00.000Z",
  url: "/api/app/planner/tasks/t1/attachments/a-1/quote.pdf",
};

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
  fetchAsk.mockResolvedValue(IDLE);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Number.POSITIVE_INFINITY },
    },
  });
  const detail: PlannerTaskDetailResponse = {
    task: TASK,
    plan: null,
    project: null,
    comments: [],
    attachments: [],
    files_read: true,
  };
  queryClient.setQueryData(plannerQueryKeys.detail(TASK_ID), detail);
});

afterEach(() => {
  mounted?.unmount();
  mounted = undefined;
  queryClient.clear();
});

const cachedFiles = () =>
  queryClient.getQueryData<PlannerTaskDetailResponse>(
    plannerQueryKeys.detail(TASK_ID),
  )?.attachments ?? [];

function show(task: string | null) {
  mounted = plannerTestMount(
    <PlannerAskChat
      state={{ conversation: null, fresh: false, draft: "" }}
      task={task}
      onChange={() => {}}
    />,
    { queryClient },
  );
  return mounted.container;
}

/** A drop of files on the chat, as the browser fires it. */
async function drop(target: Element, files: File[]) {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: { files } });
  await act(async () => {
    target.dispatchEvent(event);
  });
}

describe("PlannerAskChat files", () => {
  it("puts a dropped file on the task and lists it with its state", async () => {
    const container = show(TASK_ID);
    await settle(1);
    upload.mockResolvedValueOnce({ attachment: QUOTE });

    await drop(container.firstElementChild as Element, [
      new File(["%PDF"], "quote.pdf", { type: "application/pdf" }),
    ]);
    expect(upload).toHaveBeenCalledWith(TASK_ID, expect.any(File));
    await settle();

    expect(cachedFiles().map((entry) => entry.id)).toEqual(["a-1"]);
    const list = container.querySelector('[data-testid="planner-ask-files"]');
    expect(list?.textContent).toContain("Put on the task");
    expect(list?.textContent).toContain("quote.pdf · reading…");
  });

  it("takes a pasted file from the question box, and ignores files in Ask my diary's own chat", async () => {
    const container = show(TASK_ID);
    await settle(1);
    upload.mockResolvedValueOnce({ attachment: QUOTE });
    const box = container.querySelector("textarea") as HTMLTextAreaElement;
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [new File(["x"], "shot.png", { type: "image/png" })] },
    });
    await act(async () => {
      box.dispatchEvent(paste);
    });
    expect(upload).toHaveBeenCalledTimes(1);

    mounted?.unmount();
    upload.mockClear();
    const global = show(null);
    await settle(1);
    await drop(global.firstElementChild as Element, [
      new File(["x"], "shot.png", { type: "image/png" }),
    ]);
    expect(upload).not.toHaveBeenCalled();
    expect(
      global.querySelector('[data-testid="planner-ask-files"]'),
    ).toBeNull();
  });
});
