# Files on cockpit tasks

A screenshot, a PDF, an email or any other file can be put on a cockpit task
from the task panel. This is the fork's own feature (upstream has attachments
on memos and articles, not on tasks); its design and plan are the "Task
Attachments Plan" page in the project. Phase 1 (store and show) is what this
document describes; phase 2 (every file read into a proposed comment) and
phase 3 (the agent lists the files) are noted where they will land.

## What the owner sees

- An **Attachments** section in the task panel, between Notes and Comments,
  with "2 of 10" beside its heading.
- Files arrive by **drop** on the section, by **paste** while the panel is open
  (a paste into a text box stays a paste into that box) or from **choose
  files**. They upload one at a time and show dimmed until stored.
- Each file shows a picture (images) or its type in a word, its name as a link
  that opens it in a new tab, its size and its state in plain words:
  `stored` now; `reading…`, `comment proposed`, `comment added`, `dismissed`,
  `not read: cap reached`, `not read: unreadable` once phase 2 ships.
- **Remove** asks first. The file leaves the task at once and is deleted for
  good seven days later.
- History gets a line per file: "Attached quote.pdf", "Removed quote.pdf".

## Limits

| Limit | Value | Where |
| --- | --- | --- |
| Size of one file | 10 MB | `plannerAttachmentMaxBytes` (contracts); checked in the panel, on the declared length and on the real bytes |
| Files on one task | 10 | `plannerAttachmentsPerTask`; checked in the panel and twice on the server |
| File name | 200 characters, no `/`, `\` or control characters | `plannerNormalizeAttachmentName` |
| Removed file kept | 7 days | `PLANNER_ATTACHMENT_PURGE_DAYS` |
| Storage quota | upstream's `attachmentStorageBytes` plan limit (unlimited self-hosted) | `assertAttachmentStorageQuota` |

## Where the data is

- **Bytes**: the ATTACHMENTS R2 bucket, the same one memo files use, under
  `planner/<user>/<uuid>/<safe name>`. Not in the D1 backup; the dev clone does
  not copy them.
- **Index**: `planner_task_attachment` (migration 9016): id, user, task (by
  value, no foreign key), name, type, size, key, etag, `read_state`,
  `action_id` (phase 2), `created_at`, `removed_at`. Restored verbatim by the
  backup (`scripts/persistence-manifest.mjs`).
- **Switch**: `planner_task_plan.files_read` (same migration): NULL or 1 reads
  every file dropped on the task, 0 only stores it. Not shown until phase 2.
- **Archive**: `attachment_added` and `attachment_removed` events in
  `planner_task_event`, with `{attachment_id, filename, size}`.

## API

All under `/api/app/planner`, authenticated like the rest of the cockpit (cookie
session with FlareMo's Origin, or a `memos_pat_` token).

| Route | Does |
| --- | --- |
| `GET /tasks/:id/attachments` | The task's live files, oldest first. Also in `GET /tasks/:id` as `attachments`. |
| `POST /tasks/:id/attachments` | The file as the raw body; its MIME type in `Content-Type`, its name percent-encoded in `x-planner-filename`. 201 with the file, 413 over 10 MB, 400 when the task is full or the file is empty. |
| `GET /tasks/:id/attachments/:aid/:filename` | The bytes, with range and ETag handling; images, PDFs and plain text inline, the rest as a download. |
| `DELETE /attachments/:id` | Removes the file (soft). |

The upload puts the object first and records the row second; if the row fails
the object is deleted again, so the bucket never holds a file no task knows.

## The sweep

`forkTaskAttachmentsNightly` (apps/worker/src/fork/task-attachments.ts) runs in
the nightly block after the agent sweep. It marks files of purged tasks as
removed, then deletes the objects and rows of files removed over seven days
ago, 100 at a time. A failure is logged and never stops the rest of the night.

## Code

| File | Holds |
| --- | --- |
| `migrations/9016_planner_task_attachment.sql` | The table and the switch column. |
| `packages/db/src/schema/planner.ts` | `plannerTaskAttachment`, `plannerTaskPlan.filesRead`. |
| `packages/contracts/src/planner.ts` | Limits, the header name, the DTO and response schemas. |
| `packages/domain/src/planner/attachments.ts` | Add, list, load, remove, the sweep's two halves, the History events. |
| `apps/worker/src/routes/planner-attachments-api.ts` | The four routes. |
| `apps/worker/src/fork/task-attachments.ts` | Serving a file; the nightly purge. |
| `apps/web/src/planner/task-panel-attachments.tsx` | The panel section. |
| `apps/web/src/planner/api.ts`, `strings.ts`, `history-labels.ts` | The client calls, the words (en and zh-CN), the History labels. |

Tests: `packages/domain/src/planner/attachments.test.ts`,
`apps/worker/src/routes/planner-attachments-api.test.ts`,
`apps/web/src/planner/task-panel-attachments.test.tsx`.

## Undoing it

Remove the files in the table above and the three hook-in lines (the planner
route mount, the nightly call, the panel section). The table and column stay;
fork migrations are never rolled back. Objects under `planner/` in the bucket
can be deleted by prefix.
