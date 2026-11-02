# Files on cockpit tasks

A screenshot, a PDF, an email or any other file can be put on a cockpit task
from the task panel. This is the fork's own feature (upstream has attachments
on memos and articles, not on tasks); its design and plan are the "Task
Attachments Plan" page in the project. Phase 1 (store and show) and phase 2
(every file read into a proposed comment) are what this document describes;
phase 3 (the agent takes files in its drawer) is noted where it will land.

## What the owner sees

- An **Attachments** section in the task panel, between Notes and Comments,
  with "2 of 10" beside its heading.
- Files arrive by **drop** on the section, by **paste** while the panel is open
  (a paste into a text box stays a paste into that box) or from **choose
  files**. They upload one at a time and show dimmed until stored.
- Each file shows a picture (images) or its type in a word, its name as a link
  that opens it in a new tab, its size and its state in plain words:
  `stored`, `reading…`, `comment proposed`, `comment added`, `dismissed`,
  `stored only`, `not read: cap reached`, `not read: unreadable`.
- **Reading.** Once a file is stored it is read into a **proposed comment**: a
  card under the file with the file's text and Accept and Dismiss, the same
  card the agent's chat uses. Accept is what writes the comment (its History
  line names the proposal); Dismiss puts the card away and the file stays. A
  text file is taken as it is, an email (`.eml`) is reduced to From, To, Cc,
  Date, Subject and its body, a picture or a PDF is transcribed by Claude; any
  other kind is stored and marked unreadable. Long text is cut at 5,000
  characters with a mark. **Read** / **Read again** asks for a read on a file
  that was not read, failed, was capped or whose card was dismissed.
- **Store only, don't read these files**, a switch under the list, keeps the
  task's files stored without reading them (an old quote the owner does not
  want on the task as text). Read again still reads one when asked.
- Reading is only offered where the general agent is set up (the deployment
  has `ANTHROPIC_API_KEY`); elsewhere files are stored and shown, nothing more.
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
| Reads a month | 200, over every task; a read counts when it starts, so retries count | `plannerAttachmentReadsPerMonth`; the file shows `not read: cap reached` |
| Proposals a day | the agent's 30, shared with its chats; the file shows `not read: cap reached` and Read again tomorrow files it | `PLANNER_AGENT_ACTIONS_PER_DAY` |
| Comment length | 5,000 characters, then `[cut: the file goes on]` | `plannerAttachmentReadMax`, `plannerCutComment` |
| One transcription | 2,500 output tokens, 90 seconds | `apps/worker/src/fork/attachment-read.ts` |

## Where the data is

- **Bytes**: the ATTACHMENTS R2 bucket, the same one memo files use, under
  `planner/<user>/<uuid>/<safe name>`. Not in the D1 backup; the dev clone does
  not copy them.
- **Index**: `planner_task_attachment` (migration 9016): id, user, task (by
  value, no foreign key), name, type, size, key, etag, `read_state` (`stored`,
  `pending`, `read`, `skipped`, `capped`, `failed`), `action_id` (the proposal
  the last read filed), `created_at`, `removed_at`. Restored verbatim by the
  backup (`scripts/persistence-manifest.mjs`).
- **The proposal**: a `planner_agent_action` row of kind `comment_new` with
  `{body, attachment_id, filename}` and `why` "Read from <name>", no run and no
  conversation. The detail returns it on the file as `proposal`. Accepting it
  calls `plannerAddComment`; the comment's History line is the proposal's, so
  revert works as for any agent comment.
- **Switch**: `planner_task_plan.files_read` (same migration): NULL or 1 reads
  every file dropped on the task, 0 only stores it. In the detail as
  `files_read`. Setting it writes no History event.
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
| `POST /attachments/:id/read` | Read again. 400 where reading is not set up, 409 while the file is `pending`; else claims the read and answers the file as it stands. |
| `PATCH /tasks/:id/attachments/settings` | `{files_read: boolean}`, the task's switch. |

The upload puts the object first and records the row second; if the row fails
the object is deleted again, so the bucket never holds a file no task knows.

## The read

After an upload, where `ANTHROPIC_API_KEY` is set, the Worker claims a read
(`plannerClaimAttachmentRead`): the file goes `pending`, or `skipped` when the
task is store-only, or `capped` when the month's 200 are used. The read itself
(`forkReadAttachment`) runs after the response (`waitUntil`), and the panel
asks for the detail every three seconds while a file is pending. Text and email
are parsed in the Worker (`packages/domain/src/planner/attachment-text.ts`);
a picture or a PDF goes once to Claude's Messages API as an image or document
block, with a system prompt that asks for a faithful transcription and nothing
else, under `claude-sonnet-5-5` (`FLAREMO_ATTACHMENT_MODEL` overrides). The
text becomes a `comment_new` proposal and the file goes `read`; the day's
proposal cap makes it `capped`, any error `failed`. Read again on a file that
already has a card dismisses that card first, so a file shows one card. Nothing
of a file or its text is logged: only the kind and an error's status.

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
| `packages/contracts/src/planner-agent.ts` | The `comment_new` proposal kind. |
| `packages/domain/src/planner/attachments.ts` | Add, list, load, remove, the sweep's two halves, the History events; the switch, the read states, the month cap and the claim. |
| `packages/domain/src/planner/attachment-text.ts` | What kind a file is; the 5,000-character cut; an email as text. |
| `packages/domain/src/planner/agent-apply.ts` | Accepting `comment_new` writes the comment. |
| `packages/domain/src/planner/agent-tools.ts` | `read_task` lists the files and their state. |
| `apps/worker/src/routes/planner-attachments-api.ts` | The six routes. |
| `apps/worker/src/fork/task-attachments.ts` | Serving a file; the nightly purge. |
| `apps/worker/src/fork/attachment-read.ts` | The read after the response; the one Messages API call for pictures and PDFs. |
| `apps/web/src/planner/task-panel-attachments.tsx` | The panel section: the list, the states, the card under a file, Read again, the switch. |
| `apps/web/src/planner/ask-chat.tsx` | `PlannerProposalCard`, shared with the chat, renders a proposed comment. |
| `apps/web/src/planner/api.ts`, `strings.ts`, `history-labels.ts` | The client calls, the words (en and zh-CN), the History labels. |

Tests: `packages/domain/src/planner/attachments.test.ts`,
`packages/domain/src/planner/attachment-text.test.ts`,
`apps/worker/src/routes/planner-attachments-api.test.ts`,
`apps/web/src/planner/task-panel-attachments.test.tsx`.

## Undoing it

Remove the files in the table above and the hook-in lines (the planner route
mount, the nightly call, the panel section, the `comment_new` case in
`agent-apply.ts`, the Files block in `agent-tools.ts`). The table and column
stay; fork migrations are never rolled back. Objects under `planner/` in the
bucket can be deleted by prefix. Open `comment_new` proposals expire with the
agent's seven-day sweep.
