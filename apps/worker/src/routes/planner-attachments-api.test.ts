import {
  type PlannerAttachmentListResponse,
  type PlannerAttachmentResponse,
  type PlannerCreateTaskResponse,
  type PlannerTaskDetailResponse,
  type PlannerTaskHistoryResponse,
  plannerAttachmentMaxBytes,
  plannerAttachmentNameHeader,
  plannerAttachmentResponseSchema,
} from "@flaremo/contracts";
import { applyPlannerMigrations } from "@flaremo/db/src/planner-migrations";
import type { Miniflare } from "miniflare";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createAppTestHarness } from "../test-support/app";
import { createTestRuntime, fetchWorker } from "../test-support/runtime";
import { bootstrapAndSignIn } from "../test-support/sign-in";

// HTTP tests for files on cockpit tasks (fork-owned add-on,
// docs/fork-task-attachments.md): upload as a raw body, list, the detail, the
// file itself, removal, and the limits. Through the real Worker entry with the
// owner's cookie session; the bucket is Miniflare's R2.

const API = "/api/app/planner";
const RESET_TABLES = [
  "planner_task_event",
  "planner_task_plan",
  "planner_task_attachment",
  "task_activity",
  "tasks",
] as const;

type Context = {
  runtime: Miniflare;
  d1: D1Database;
  env: Env;
  cookie: string;
};

describe("planner attachments API", () => {
  let ctx: Context;
  let TODAY: string;

  const harness = createAppTestHarness(() => ({
    env: ctx.env,
    sessionCookie: ctx.cookie,
  }));

  beforeAll(async () => {
    const {
      runtime,
      db: d1,
      env,
    } = await createTestRuntime({
      name: "flaremo-planner-attachments",
      env: { FLAREMO_EMBEDDING_PROVIDER: "none" },
    });
    await applyPlannerMigrations(d1);
    ctx = { runtime, d1, env, cookie: await bootstrapAndSignIn(env) };
  });

  afterAll(async () => {
    await ctx.runtime.dispose();
  });

  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    await ctx.d1.batch(
      RESET_TABLES.map((table) => ctx.d1.prepare(`DELETE FROM ${table}`)),
    );
    TODAY = new Date().toISOString().slice(0, 10);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const url = (path: string) => `http://flaremo.test${path}`;

  const sendJson = (method: string, path: string, body?: unknown) =>
    harness.fetchApp(url(path), {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });

  /** A file as the panel sends it: the bytes as the body, the name in a header. */
  const upload = (
    taskId: string,
    name: string,
    bytes: Uint8Array | string,
    type = "text/plain",
  ) =>
    harness.fetchApp(url(`${API}/tasks/${bare(taskId)}/attachments`), {
      method: "POST",
      headers: {
        "content-type": type,
        [plannerAttachmentNameHeader]: encodeURIComponent(name),
      },
      body: bytes,
    });

  async function body<T>(
    response: Response | Promise<Response>,
    status = 200,
  ): Promise<T> {
    const res = await response;
    const text = await res.text();
    expect(res.status, text).toBe(status);
    return JSON.parse(text) as T;
  }

  const bare = (id: string) => id.replace(/^tasks\//, "");

  async function createTask(title: string) {
    const created = await body<PlannerCreateTaskResponse>(
      sendJson("POST", `${API}/tasks`, { title, today: TODAY }),
      201,
    );
    return created.task;
  }

  // ===========================================================================

  it("stores a file, lists it, shows it in the detail and serves it back inline", async () => {
    const task = await createTask("Renew the insurance");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

    const uploaded = await body<PlannerAttachmentResponse>(
      upload(task.id, "my screenshot.png", png, "image/png"),
      201,
    );
    expect(plannerAttachmentResponseSchema.parse(uploaded)).toEqual(uploaded);
    expect(uploaded.attachment).toMatchObject({
      task_id: task.id,
      filename: "my screenshot.png",
      content_type: "image/png",
      size: png.byteLength,
      read_state: "stored",
      action_id: null,
      url: `${API}/tasks/${bare(task.id)}/attachments/${uploaded.attachment.id}/my%20screenshot.png`,
    });

    const listed = await body<PlannerAttachmentListResponse>(
      sendJson("GET", `${API}/tasks/${bare(task.id)}/attachments`),
    );
    expect(listed.attachments).toEqual([uploaded.attachment]);
    const detail = await body<PlannerTaskDetailResponse>(
      sendJson("GET", `${API}/tasks/${bare(task.id)}`),
    );
    expect(detail.attachments).toEqual([uploaded.attachment]);

    const served = await harness.fetchApp(url(uploaded.attachment.url));
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("content-disposition")).toContain("inline");
    expect(served.headers.get("cache-control")).toContain("private");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);

    // The History line names the file.
    const history = await body<PlannerTaskHistoryResponse>(
      sendJson("GET", `${API}/tasks/${bare(task.id)}/history`),
    );
    const added = history.events.find(
      (event) => event.type === "attachment_added",
    );
    expect(added?.data).toEqual({
      attachment_id: uploaded.attachment.id,
      filename: "my screenshot.png",
      size: png.byteLength,
    });
    expect(added?.actor_type).toBe("user");
  });

  it("removes a file: it leaves the list and the detail, and its bytes answer 404", async () => {
    const task = await createTask("With a file");
    const { attachment } = await body<PlannerAttachmentResponse>(
      upload(task.id, "notes.txt", "hello"),
      201,
    );

    expect(
      await body(sendJson("DELETE", `${API}/attachments/${attachment.id}`)),
    ).toEqual({ ok: true });
    const listed = await body<PlannerAttachmentListResponse>(
      sendJson("GET", `${API}/tasks/${bare(task.id)}/attachments`),
    );
    expect(listed.attachments).toEqual([]);
    expect((await harness.fetchApp(url(attachment.url))).status).toBe(404);
    expect(
      (await sendJson("DELETE", `${API}/attachments/${attachment.id}`)).status,
    ).toBe(404);
    // The object itself stays for the sweep.
    const row = await ctx.d1
      .prepare("SELECT r2_key, removed_at FROM planner_task_attachment")
      .first<{ r2_key: string; removed_at: string | null }>();
    expect(row?.removed_at).not.toBeNull();
    expect(await ctx.env.ATTACHMENTS.head(row?.r2_key ?? "")).not.toBeNull();
  });

  it("refuses a file over 10 MB with 413, an empty one with 400, and an eleventh with 400, storing nothing", async () => {
    const task = await createTask("Limits");
    const before = (await ctx.env.ATTACHMENTS.list({ prefix: "planner/" }))
      .objects.length;
    const big = new Uint8Array(plannerAttachmentMaxBytes + 1);
    expect((await upload(task.id, "big.bin", big)).status).toBe(413);
    expect((await upload(task.id, "empty.txt", "")).status).toBe(400);
    for (let n = 0; n < 10; n++) {
      await body(upload(task.id, `f${n}.txt`, `file ${n}`), 201);
    }
    const eleventh = await upload(task.id, "f10.txt", "one too many");
    expect(eleventh.status).toBe(400);
    expect(await eleventh.text()).toContain("at most 10 files");

    // Only the ten accepted files reached the bucket.
    const after = (await ctx.env.ATTACHMENTS.list({ prefix: "planner/" }))
      .objects.length;
    expect(after - before).toBe(10);
  });

  it("answers 401 without a credential, and 404 for a task that is not the owner's", async () => {
    const task = await createTask("Private");
    const { attachment } = await body<PlannerAttachmentResponse>(
      upload(task.id, "secret.txt", "mine"),
      201,
    );
    for (const path of [
      `${API}/tasks/${bare(task.id)}/attachments`,
      attachment.url,
    ]) {
      const anonymous = await fetchWorker(new Request(url(path)), ctx.env);
      expect(anonymous.status, path).toBe(401);
    }
    const wrongTask = await harness.fetchApp(
      url(`${API}/tasks/nope/attachments/${attachment.id}/secret.txt`),
    );
    expect(wrongTask.status).toBe(404);
  });
});
