import {
  type PlannerAgentActionResponse,
  type PlannerAttachmentListResponse,
  type PlannerAttachmentResponse,
  type PlannerAttachmentSettingsResponse,
  type PlannerCreateTaskResponse,
  type PlannerTaskDetailResponse,
  type PlannerTaskHistoryResponse,
  plannerAttachmentCopyHeader,
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
// file itself, removal, and the limits; then (phase 2) the read into a proposed
// comment after an upload, "Read again", the Store-only switch and the caps.
// Through the real Worker entry with the owner's cookie session; the bucket is
// Miniflare's R2. Claude's Messages API is replaced: the harness has no
// execution context, so a read finishes before the upload answers.

const API = "/api/app/planner";
const RESET_TABLES = [
  "planner_task_event",
  "planner_task_plan",
  "planner_task_attachment",
  "planner_agent_action",
  "task_activity",
  "tasks",
] as const;

type Context = {
  runtime: Miniflare;
  d1: D1Database;
  env: Env;
  cookie: string;
  /** The env the next requests run under; reset before each test. */
  current: Env;
};

describe("planner attachments API", () => {
  let ctx: Context;
  let TODAY: string;

  const harness = createAppTestHarness(() => ({
    env: ctx.current,
    sessionCookie: ctx.cookie,
  }));

  /** Runs the following requests with the agent's key set, so files are read. */
  const withReads = () => {
    ctx.current = {
      ...ctx.env,
      ANTHROPIC_API_KEY: "test-anthropic-key",
    } as unknown as Env;
  };

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
    ctx = {
      runtime,
      d1,
      env,
      cookie: await bootstrapAndSignIn(env),
      current: env,
    };
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
    ctx.current = ctx.env;
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

  // ===========================================================================
  // Phase 2: reading into a proposed comment

  /** Replaces Claude's Messages API; returns what was sent. */
  function stubAnthropic(
    answer: (payload: Record<string, unknown>) => Response = () =>
      Response.json({
        content: [{ type: "text", text: "Renewal: EUR 212 a year." }],
      }),
  ) {
    const realFetch = globalThis.fetch;
    const sent: { headers: Headers; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.startsWith("https://api.anthropic.com/")) {
        return realFetch(input, init);
      }
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push({ headers: new Headers(init?.headers), body: payload });
      return answer(payload);
    });
    return sent;
  }

  const detailOf = (taskId: string) =>
    body<PlannerTaskDetailResponse>(
      sendJson("GET", `${API}/tasks/${bare(taskId)}`),
    );

  it("without the agent's key a file is only stored, and Read again is refused", async () => {
    const task = await createTask("Plain");
    const { attachment } = await body<PlannerAttachmentResponse>(
      upload(task.id, "notes.txt", "hello"),
      201,
    );
    expect(attachment.read_state).toBe("stored");
    expect(attachment.proposal).toBeNull();
    const read = await sendJson(
      "POST",
      `${API}/attachments/${attachment.id}/read`,
    );
    expect(read.status).toBe(400);
    expect((await detailOf(task.id)).files_read).toBe(true);
  });

  it("reads a text file and an email into a proposed comment on upload, without Claude; Accept writes the comment", async () => {
    withReads();
    const sent = stubAnthropic();
    const task = await createTask("Renew the insurance");

    const text = await body<PlannerAttachmentResponse>(
      upload(task.id, "notes.txt", "Call the broker on Tuesday.\n"),
      201,
    );
    expect(plannerAttachmentResponseSchema.parse(text)).toEqual(text);
    expect(text.attachment.read_state).toBe("read");
    expect(text.attachment.proposal).toMatchObject({
      kind: "comment_new",
      task_id: task.id,
      state: "open",
      why: "Read from notes.txt",
      change: {
        body: "Text of notes.txt\n\nCall the broker on Tuesday.",
        attachment_id: text.attachment.id,
        filename: "notes.txt",
        form: "text",
      },
    });
    expect(text.attachment.action_id).toBe(text.attachment.proposal?.id);

    const mail = [
      "From: Insurer <quotes@example.com>",
      "Subject: Your renewal",
      "Content-Type: text/plain",
      "",
      "EUR 212 a year.",
    ].join("\r\n");
    const email = await body<PlannerAttachmentResponse>(
      upload(task.id, "renewal.eml", mail, "message/rfc822"),
      201,
    );
    expect(email.attachment.read_state).toBe("read");
    expect(email.attachment.proposal?.change.body).toBe(
      "Text of renewal.eml\n\nFrom: Insurer <quotes@example.com>\nSubject: Your renewal\n\nEUR 212 a year.",
    );
    expect(sent).toHaveLength(0);

    // The detail carries the cards; nothing is a comment until accepted.
    const before = await detailOf(task.id);
    expect(before.comments).toEqual([]);
    expect(before.attachments.map((a) => a.proposal?.state)).toEqual([
      "open",
      "open",
    ]);
    const accepted = await body<PlannerAgentActionResponse>(
      sendJson("POST", `${API}/agent/actions/${text.attachment.action_id}`, {
        state: "accepted",
        today: TODAY,
      }),
    );
    expect(accepted.action.state).toBe("accepted");
    const after = await detailOf(task.id);
    expect(after.comments.map((c) => c.body)).toEqual([
      "Text of notes.txt\n\nCall the broker on Tuesday.",
    ]);
    expect(accepted.action.landed_id).toBe(after.comments[0]?.id);
    expect(after.attachments[0]?.proposal?.state).toBe("accepted");
    // The History shows the comment as the proposal's.
    const history = await body<PlannerTaskHistoryResponse>(
      sendJson("GET", `${API}/tasks/${bare(task.id)}/history`),
    );
    const commented = history.events.find((e) => e.type === "commented");
    expect(commented?.actor_type).toBe("agent");
  });

  it("sends a picture to Claude once, as an image block with the agent's key, and files what comes back", async () => {
    withReads();
    const sent = stubAnthropic();
    const task = await createTask("Screenshot");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

    const { attachment } = await body<PlannerAttachmentResponse>(
      upload(task.id, "quote.png", png, "image/png"),
      201,
    );
    expect(attachment.read_state).toBe("read");
    expect(attachment.proposal?.change.body).toBe(
      "Text of quote.png\n\nRenewal: EUR 212 a year.",
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.get("x-api-key")).toBe("test-anthropic-key");
    expect(sent[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(sent[0]?.body).toMatchObject({
      model: "claude-sonnet-5-5",
      // The answer's 2,500 tokens plus room to think.
      max_tokens: 6500,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: btoa(String.fromCharCode(...png)),
              },
            },
            { type: "text", text: "Read this file." },
          ],
        },
      ],
    });
    expect(String(sent[0]?.body.system)).toContain("read one file");

    // A PDF goes as a document, under the model from the env when one is set.
    ctx.current = {
      ...ctx.current,
      FLAREMO_ATTACHMENT_MODEL: "claude-haiku-5-5",
    } as unknown as Env;
    const pdf = await body<PlannerAttachmentResponse>(
      upload(task.id, "quote.pdf", "%PDF-1.4", "application/pdf"),
      201,
    );
    expect(pdf.attachment.read_state).toBe("read");
    expect(sent[1]?.body).toMatchObject({
      model: "claude-haiku-5-5",
      messages: [
        {
          content: [
            {
              type: "document",
              source: { type: "base64", media_type: "application/pdf" },
            },
            { type: "text" },
          ],
        },
      ],
    });
    // Nothing of the file is logged.
    const logged = vi
      .mocked(console.error)
      .mock.calls.flat()
      .map(String)
      .join("\n");
    expect(logged).not.toContain("Renewal");
  });

  it("marks a file Claude could not read, or of an unknown kind, as unreadable; Read again tries once more, and 409 while pending", async () => {
    withReads();
    let fail = true;
    const sent = stubAnthropic(() =>
      fail
        ? new Response("overloaded", { status: 529 })
        : Response.json({ content: [{ type: "text", text: "Second time." }] }),
    );
    const task = await createTask("Retry");

    const { attachment } = await body<PlannerAttachmentResponse>(
      upload(task.id, "shot.png", new Uint8Array([1, 2, 3]), "image/png"),
      201,
    );
    expect(attachment.read_state).toBe("failed");
    expect(attachment.proposal).toBeNull();
    const zip = await body<PlannerAttachmentResponse>(
      upload(task.id, "archive.zip", "PK", "application/zip"),
      201,
    );
    expect(zip.attachment.read_state).toBe("failed");
    expect(sent).toHaveLength(1);

    fail = false;
    const again = await body<PlannerAttachmentResponse>(
      sendJson("POST", `${API}/attachments/${attachment.id}/read`),
    );
    expect(again.attachment.read_state).toBe("read");
    expect(again.attachment.proposal?.change.body).toBe(
      "Text of shot.png\n\nSecond time.",
    );
    expect(sent).toHaveLength(2);

    // Read again on a read file puts the earlier card away: one card a file.
    const third = await body<PlannerAttachmentResponse>(
      sendJson("POST", `${API}/attachments/${attachment.id}/read`),
    );
    expect(third.attachment.proposal?.id).not.toBe(
      again.attachment.proposal?.id,
    );
    const earlier = await ctx.d1
      .prepare("SELECT state FROM planner_agent_action WHERE id = ?")
      .bind(again.attachment.proposal?.id)
      .first<{ state: string }>();
    expect(earlier?.state).toBe("dismissed");

    await ctx.d1
      .prepare(
        "UPDATE planner_task_attachment SET read_state = 'pending' WHERE id = ?",
      )
      .bind(attachment.id)
      .run();
    const busy = await sendJson(
      "POST",
      `${API}/attachments/${attachment.id}/read`,
    );
    expect(busy.status).toBe(409);

    // A read lost long ago (pending past the queue's limit) is taken back by
    // Read again, though not by the browser's first read.
    await ctx.d1
      .prepare(
        "UPDATE planner_task_attachment SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?",
      )
      .bind(attachment.id)
      .run();
    const first = await sendJson(
      "POST",
      `${API}/attachments/${attachment.id}/read?first=1`,
    );
    expect(first.status).toBe(409);
    const recovered = await body<PlannerAttachmentResponse>(
      sendJson("POST", `${API}/attachments/${attachment.id}/read`),
    );
    expect(recovered.attachment.read_state).toBe("read");
  });

  it("puts a read on the queue when there is one, and the consumer reads it", async () => {
    withReads();
    stubAnthropic(() =>
      Response.json({ content: [{ type: "text", text: "From the queue." }] }),
    );
    const queued: unknown[] = [];
    ctx.current = {
      ...ctx.current,
      DATA_EXPORT_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as unknown as Env;
    const task = await createTask("Queued");
    const { attachment } = await body<PlannerAttachmentResponse>(
      upload(task.id, "shot.png", new Uint8Array([1, 2, 3]), "image/png"),
      201,
    );
    expect(attachment.read_state).toBe("pending");
    expect(queued).toHaveLength(1);
    const { forkIsQueueMessage, forkRunQueue } = await import("../fork/queue");
    expect(forkIsQueueMessage(queued[0])).toBe(true);
    expect(forkIsQueueMessage({ taskId: "export" })).toBe(false);
    await forkRunQueue(ctx.current as never, queued);
    const list = await body<PlannerAttachmentListResponse>(
      sendJson("GET", `${API}/tasks/${bare(task.id)}/attachments`),
    );
    expect(list.attachments[0]?.read_state).toBe("read");
    expect(list.attachments[0]?.proposal?.change.body).toBe(
      "Text of shot.png\n\nFrom the queue.",
    );
    // A second delivery of the same message finds nothing pending and reads nothing.
    await forkRunQueue(ctx.current as never, queued);
  });

  it("keeps a task's files stored only when its switch is set, and Read again still reads one", async () => {
    withReads();
    const sent = stubAnthropic();
    const task = await createTask("Store only");

    const settings = await body<PlannerAttachmentSettingsResponse>(
      sendJson("PATCH", `${API}/tasks/${bare(task.id)}/attachments/settings`, {
        files_read: false,
      }),
    );
    expect(settings).toEqual({ files_read: false });
    expect((await detailOf(task.id)).files_read).toBe(false);
    expect(
      (
        await sendJson(
          "PATCH",
          `${API}/tasks/${bare(task.id)}/attachments/settings`,
          {
            files_read: "no",
          },
        )
      ).status,
    ).toBe(400);

    const { attachment } = await body<PlannerAttachmentResponse>(
      upload(task.id, "shot.png", new Uint8Array([1, 2, 3]), "image/png"),
      201,
    );
    expect(attachment.read_state).toBe("skipped");
    expect(sent).toHaveLength(0);

    const forced = await body<PlannerAttachmentResponse>(
      sendJson("POST", `${API}/attachments/${attachment.id}/read`),
    );
    expect(forced.attachment.read_state).toBe("read");
    expect(sent).toHaveLength(1);

    await body(
      sendJson("PATCH", `${API}/tasks/${bare(task.id)}/attachments/settings`, {
        files_read: true,
      }),
    );
    expect((await detailOf(task.id)).files_read).toBe(true);
  });

  it("stops at 200 reads a month and says so on the file", async () => {
    withReads();
    const sent = stubAnthropic();
    const task = await createTask("Capped");
    const other = await createTask("Other");
    const month = `${TODAY.slice(0, 7)}-01T12:00:00.000Z`;
    const rows = Array.from({ length: 200 }, (_, n) =>
      ctx.d1
        .prepare(
          `INSERT INTO planner_task_attachment
             (id, user_id, task_id, filename, content_type, size, r2_key, etag, read_state, action_id, created_at, removed_at)
           SELECT ?, user_id, ?, ?, 'text/plain', 1, ?, 'e', 'read', NULL, ?, NULL FROM tasks WHERE id = ?`,
        )
        .bind(
          `read-${n}`,
          other.id,
          `r${n}.txt`,
          `planner/x/r${n}.txt`,
          month,
          other.id,
        ),
    );
    for (let i = 0; i < rows.length; i += 40) {
      await ctx.d1.batch(rows.slice(i, i + 40));
    }

    const { attachment } = await body<PlannerAttachmentResponse>(
      upload(task.id, "late.png", new Uint8Array([1]), "image/png"),
      201,
    );
    expect(attachment.read_state).toBe("capped");
    expect(sent).toHaveLength(0);
    const again = await body<PlannerAttachmentResponse>(
      sendJson("POST", `${API}/attachments/${attachment.id}/read`),
    );
    expect(again.attachment.read_state).toBe("capped");
  });

  it("strips a web page to what a reader sees, and summarises a long document instead of cutting it", async () => {
    withReads();
    const sent = stubAnthropic(() =>
      Response.json({
        content: [
          {
            type: "text",
            text: "Summary\nA pilot snapshot for Esther, dated 2 Nov 2026.\n- Two coaches in pilot: Portfolio Coach and PMO Coach.",
          },
        ],
      }),
    );
    const task = await createTask("Prepare the snapshot for Esther");

    // A short page: its visible text, whole, without Claude.
    const page = [
      "<!doctype html><!-- build notes, not for the reader -->",
      "<html><head><title>AI in the TO</title><style>p{color:red}</style></head>",
      "<body><h1>Pilot snapshot</h1><script>alert(1)</script>",
      "<p>Users: Emily &amp; Howard</p><table><tr><td>Reads</td><td>5 files</td></tr></table>",
      "</body></html>",
    ].join("");
    const short = await body<PlannerAttachmentResponse>(
      upload(task.id, "short.html", page, "text/html"),
      201,
    );
    expect(short.attachment.read_state).toBe("read");
    expect(short.attachment.proposal?.change.body).toBe(
      "Text of short.html\n\nAI in the TO\nPilot snapshot\nUsers: Emily & Howard\nReads · 5 files",
    );
    expect(sent).toHaveLength(0);

    // A long page: Claude gets the visible text only, and a summary comes back.
    const lines = Array.from(
      { length: 400 },
      (_, n) =>
        `<p>Step ${n + 1}: a line of the process map with its owner.</p>`,
    ).join("");
    const long = await body<PlannerAttachmentResponse>(
      upload(
        task.id,
        "snapshot.html",
        `<html><head><style>.x{}</style></head><body>${lines}</body></html>`,
        "text/html",
      ),
      201,
    );
    expect(long.attachment.read_state).toBe("read");
    expect(long.attachment.proposal?.change).toMatchObject({
      form: "summary",
      body: "Summary of snapshot.html\n\nA pilot snapshot for Esther, dated 2 Nov 2026.\n- Two coaches in pilot: Portfolio Coach and PMO Coach.",
    });
    expect(sent).toHaveLength(1);
    const prompt = JSON.stringify(sent[0]?.body);
    expect(prompt).toContain("Step 400: a line of the process map");
    expect(prompt).not.toContain("<p>");
    expect(prompt).not.toContain(".x{}");
    expect(String(sent[0]?.body.system)).toContain("summarise one document");
  });

  it("ends a summary on a whole line when the model stops at its token limit", async () => {
    withReads();
    stubAnthropic(() =>
      Response.json({
        stop_reason: "max_tokens",
        content: [
          {
            type: "text",
            text: "Summary\nA pilot snapshot, 2 Nov 2026.\n- Two coaches in pilot.\n- Later, unverified: Outlook drafts, memory, refresh,",
          },
        ],
      }),
    );
    const task = await createTask("Cut short");
    const { attachment } = await body<PlannerAttachmentResponse>(
      upload(task.id, "long.pdf", "%PDF-1.4", "application/pdf"),
      201,
    );
    expect(attachment.proposal?.change.body).toBe(
      "Summary of long.pdf\n\nA pilot snapshot, 2 Nov 2026.\n- Two coaches in pilot.",
    );
  });

  // --- Audio, video and iPhone photos: the reading copy ----------------------

  /** Whisper on the AI binding, replaced: each call answers the next words. */
  const withWhisper = (answers: string[]) => {
    const run = vi.fn(async (_model: string, _input: { audio: string }) => ({
      text: answers.shift() ?? "",
    }));
    ctx.current = { ...ctx.current, AI: { run } } as unknown as Env;
    return run;
  };

  const uploadWithCopy = (
    taskId: string,
    name: string,
    bytes: Uint8Array | string,
    type: string,
  ) =>
    harness.fetchApp(url(`${API}/tasks/${bare(taskId)}/attachments`), {
      method: "POST",
      headers: {
        "content-type": type,
        [plannerAttachmentNameHeader]: encodeURIComponent(name),
        [plannerAttachmentCopyHeader]: "1",
      },
      body: bytes,
    });

  const putPart = (id: string, part: string, bytes: Uint8Array, type: string) =>
    harness.fetchApp(url(`${API}/attachments/${id}/copy/${part}`), {
      method: "PUT",
      headers: { "content-type": type },
      body: bytes,
    });

  it("transcribes a recording from its reading copy with Whisper, part by part, and keeps a short transcript whole", async () => {
    withReads();
    const sent = stubAnthropic();
    const run = withWhisper([
      "Call the plumber on Friday.",
      "Budget is 300 euros.",
    ]);
    const task = await createTask("Voice memo");

    const { attachment } = await body<PlannerAttachmentResponse>(
      uploadWithCopy(
        task.id,
        "memo.m4a",
        new Uint8Array([1, 2, 3]),
        "audio/mp4",
      ),
      201,
    );
    // Stored, not read: the copy has not arrived yet.
    expect(attachment.read_state).toBe("stored");
    expect(run).not.toHaveBeenCalled();

    const wav = new Uint8Array([82, 73, 70, 70, 9, 9]);
    await body(putPart(attachment.id, "audio-01.wav", wav, "audio/wav"));
    await body(putPart(attachment.id, "audio-02.wav", wav, "audio/wav"));
    const read = await body<PlannerAttachmentResponse>(
      sendJson("POST", `${API}/attachments/${attachment.id}/read?first=1`),
    );
    expect(read.attachment.read_state).toBe("read");
    expect(read.attachment.proposal?.change.body).toBe(
      "Transcript of memo.m4a\n\nCall the plumber on Friday. Budget is 300 euros.",
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toBe("@cf/openai/whisper-large-v3-turbo");
    expect(run.mock.calls[0]?.[1]).toEqual({
      audio: btoa(String.fromCharCode(...wav)),
    });
    // A short transcript needs no Claude.
    expect(sent).toHaveLength(0);
  });

  it("sends a recording with no copy to Whisper as it is, and summarises a long transcript with Claude", async () => {
    withReads();
    const sent = stubAnthropic(() =>
      Response.json({
        content: [{ type: "text", text: "Summary\nA long talk." }],
      }),
    );
    withWhisper(["word ".repeat(1200)]);
    const task = await createTask("Lecture");
    const { attachment } = await body<PlannerAttachmentResponse>(
      upload(task.id, "talk.mp3", new Uint8Array([7, 7, 7]), "audio/mpeg"),
      201,
    );
    expect(attachment.read_state).toBe("read");
    expect(attachment.proposal?.change.body).toBe(
      "Summary of talk.mp3\n\nA long talk.",
    );
    expect(sent).toHaveLength(1);
  });

  it("reads a video from its frames and the words of its sound, in one Claude call", async () => {
    withReads();
    const sent = stubAnthropic(() =>
      Response.json({
        content: [
          {
            type: "text",
            text: "Text\nA kitchen tap drips. Someone says it started Monday.",
          },
        ],
      }),
    );
    const run = withWhisper(["It started Monday."]);
    const task = await createTask("Leak");
    const { attachment } = await body<PlannerAttachmentResponse>(
      uploadWithCopy(
        task.id,
        "leak.mov",
        new Uint8Array([0, 0, 0, 1]),
        "video/quicktime",
      ),
      201,
    );
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 1]);
    await body(putPart(attachment.id, "frame-1.jpg", jpeg, "image/jpeg"));
    await body(putPart(attachment.id, "frame-2.jpg", jpeg, "image/jpeg"));
    await body(
      putPart(attachment.id, "audio-01.wav", new Uint8Array([1]), "audio/wav"),
    );
    const read = await body<PlannerAttachmentResponse>(
      sendJson("POST", `${API}/attachments/${attachment.id}/read?first=1`),
    );
    expect(read.attachment.proposal?.change.body).toBe(
      "What's in leak.mov\n\nA kitchen tap drips. Someone says it started Monday.",
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
    const messages = sent[0]?.body.messages as
      | Array<{ content: Array<Record<string, unknown>> }>
      | undefined;
    const content = messages?.[0]?.content ?? [];
    expect(content.filter((block) => block.type === "image")).toHaveLength(2);
    expect(content[0]).toMatchObject({
      type: "image",
      source: { media_type: "image/jpeg" },
    });
    expect(String(content.at(-1)?.text)).toContain("It started Monday.");
    expect(String(sent[0]?.body.system)).toContain("read one video");
  });

  it("reads an iPhone photo from its JPEG copy, and marks one with no copy unreadable", async () => {
    withReads();
    const sent = stubAnthropic();
    const task = await createTask("Receipt");
    const { attachment } = await body<PlannerAttachmentResponse>(
      uploadWithCopy(
        task.id,
        "IMG_0001.HEIC",
        new Uint8Array([1, 2]),
        "image/heic",
      ),
      201,
    );
    await body(
      putPart(
        attachment.id,
        "frame-1.jpg",
        new Uint8Array([0xff, 0xd8]),
        "image/jpeg",
      ),
    );
    const read = await body<PlannerAttachmentResponse>(
      sendJson("POST", `${API}/attachments/${attachment.id}/read?first=1`),
    );
    expect(read.attachment.read_state).toBe("read");
    expect(sent[0]?.body).toMatchObject({
      messages: [
        {
          content: [
            { type: "image", source: { media_type: "image/jpeg" } },
            { type: "text" },
          ],
        },
      ],
    });

    const bare_ = await body<PlannerAttachmentResponse>(
      upload(task.id, "IMG_0002.heic", new Uint8Array([1, 2]), "image/heic"),
      201,
    );
    expect(bare_.attachment.read_state).toBe("failed");
    expect(sent).toHaveLength(1);
  });

  it("keeps to the store-only switch on a first read, takes only known parts, and lets audio be over 10 MB", async () => {
    withReads();
    withWhisper([]);
    const task = await createTask("Big recording");
    await body(
      sendJson("PATCH", `${API}/tasks/${bare(task.id)}/attachments/settings`, {
        files_read: false,
      }),
    );
    const big = new Uint8Array(plannerAttachmentMaxBytes + 1024);
    const { attachment } = await body<PlannerAttachmentResponse>(
      uploadWithCopy(task.id, "long.wav", big, "audio/wav"),
      201,
    );
    expect(attachment.size).toBe(big.byteLength);
    // The same size as a document is refused.
    expect((await upload(task.id, "long.txt", big)).status).toBe(413);

    expect(
      (
        await putPart(
          attachment.id,
          "evil.sh",
          new Uint8Array([1]),
          "text/plain",
        )
      ).status,
    ).toBe(400);
    const first = await body<PlannerAttachmentResponse>(
      sendJson("POST", `${API}/attachments/${attachment.id}/read?first=1`),
    );
    expect(first.attachment.read_state).toBe("skipped");
  });

  // --- Files dropped in Ask my diary ------------------------------------------

  it("reads a file dropped in a chat at once, answers its text and deletes it with its copy", async () => {
    withReads();
    stubAnthropic();
    withWhisper(["Pick up the keys at noon."]);
    const stored = await body<{ file: { id: string; filename: string } }>(
      harness.fetchApp(url(`${API}/chat-files`), {
        method: "POST",
        headers: {
          "content-type": "audio/mp4",
          [plannerAttachmentNameHeader]: encodeURIComponent("note.m4a"),
        },
        body: new Uint8Array([1, 2, 3]),
      }),
      201,
    );
    expect(stored.file.filename).toBe("note.m4a");
    await body(
      harness.fetchApp(
        url(`${API}/chat-files/${stored.file.id}/copy/audio-01.wav`),
        {
          method: "PUT",
          headers: { "content-type": "audio/wav" },
          body: new Uint8Array([9, 9]),
        },
      ),
    );
    const prefix = "planner-chat/";
    expect((await ctx.env.ATTACHMENTS.list({ prefix })).objects.length).toBe(2);
    const read = await body<{ filename: string; text: string | null }>(
      sendJson("POST", `${API}/chat-files/${stored.file.id}/read`),
    );
    expect(read).toEqual({
      filename: "note.m4a",
      text: "Transcript of note.m4a\n\nPick up the keys at noon.",
    });
    // Nothing of it is kept.
    expect((await ctx.env.ATTACHMENTS.list({ prefix })).objects).toHaveLength(
      0,
    );
    expect(
      (await sendJson("POST", `${API}/chat-files/${stored.file.id}/read`))
        .status,
    ).toBe(404);

    // A kind that cannot be read answers null, and is deleted all the same.
    const zip = await body<{ file: { id: string } }>(
      harness.fetchApp(url(`${API}/chat-files`), {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          [plannerAttachmentNameHeader]: "a.zip",
        },
        body: new Uint8Array([1]),
      }),
      201,
    );
    const unread = await body<{ text: string | null }>(
      sendJson("POST", `${API}/chat-files/${zip.file.id}/read`),
    );
    expect(unread.text).toBeNull();
    expect((await ctx.env.ATTACHMENTS.list({ prefix })).objects).toHaveLength(
      0,
    );
  });
});
