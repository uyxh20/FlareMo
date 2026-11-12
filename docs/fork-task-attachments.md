# Files on cockpit tasks

A screenshot, a PDF, an email or any other file can be put on a cockpit task
from the task panel. This is the fork's own feature (upstream has attachments
on memos and articles, not on tasks); its design and plan are the "Task
Attachments Plan" page in the project. Phase 1 (store and show), phase 2
(every file read into a proposed comment) and phase 3 (the agent knows the
files, and takes them in its chat) are what this document describes.

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
  card under the file with Accept and Dismiss, the same card the agent's chat
  uses. Accept is what writes the comment (its History line names the
  proposal); Dismiss puts the card away and the file stays. What the comment
  holds depends on the file's size, not its kind: a **short file** (its text
  under 5,000 characters) is kept whole, headed "Text of <name>"; a **long
  one** is summarised by Claude, headed "Summary of <name>": one sentence on
  what the document is, then its main points with the names, numbers and
  dates that matter, under 2,000 characters. A text file is taken as it is,
  an email (`.eml`) is reduced to From, To, Cc, Date, Subject and its body, a
  web page (`.html`) to what a reader sees (no tags, styles, scripts or
  comments), all without a model; a picture or a PDF goes to Claude, which
  writes it out when short and summarises when long. A recording is
  transcribed ("Transcript of <name>", or a summary when long), a video is
  described with what is said in it ("What's in <name>"), and an iPhone HEIC
  photo is read like any picture (see "Audio, video and iPhone photos" below).
  Any other kind (Word, Excel, zip…) is stored and marked unreadable. **Read** / **Read again** asks for a read on a file
  that was not read, failed, was capped or whose card was dismissed.
- **Store only, don't read these files**, a switch under the list, keeps the
  task's files stored without reading them (an old quote the owner does not
  want on the task as text). Read again still reads one when asked.
- Reading is only offered where the general agent is set up (the deployment
  has `ANTHROPIC_API_KEY`); elsewhere files are stored and shown, nothing more.
- **In the task's agent chat** a drop on the chat, or a paste into the question
  box, is the same upload: the file lands on the task, shows under the panel's
  Attachments, and the chat lists it above the question box with its state. So
  "here is the email, what should I do" is one motion.
- **Remove** asks first. The file leaves the task at once and is deleted for
  good seven days later.
- History gets a line per file: "Attached quote.pdf", "Removed quote.pdf".

## Limits

| Limit | Value | Where |
| --- | --- | --- |
| Size of one file | 10 MB; audio and video 95 MB | `plannerAttachmentMaxBytes`, `plannerAttachmentMediaMaxBytes`, `plannerAttachmentMaxBytesFor` (contracts); checked in the panel, on the declared length and on the real bytes |
| Transcribed per recording or video | the first 30 minutes (15 parts of two minutes) | `plannerAttachmentCopyAudioParts`, `plannerAttachmentCopyAudioSeconds` |
| Frames per video | 6, at most 1,024 px | `plannerAttachmentCopyFrames`; `attachment-reading-copy.ts` |
| One part of a reading copy | 4 MB | `plannerAttachmentCopyPartMaxBytes` |
| Files on one task | 10 | `plannerAttachmentsPerTask`; checked in the panel and twice on the server |
| File name | 200 characters, no `/`, `\` or control characters | `plannerNormalizeAttachmentName` |
| Removed file kept | 7 days | `PLANNER_ATTACHMENT_PURGE_DAYS` |
| Storage quota | upstream's `attachmentStorageBytes` plan limit (unlimited self-hosted) | `assertAttachmentStorageQuota` |
| Reads a month | 200, over every task; a read counts when it starts, so retries count | `plannerAttachmentReadsPerMonth`; the file shows `not read: cap reached` |
| Proposals a day | the agent's 30, shared with its chats; the file shows `not read: cap reached` and Read again tomorrow files it | `PLANNER_AGENT_ACTIONS_PER_DAY` |
| Kept whole | text up to 5,000 characters; longer is summarised | `plannerAttachmentReadMax`, `plannerAttachmentNeedsSummary` |
| A summary | under 2,000 characters; the model sees at most 150,000 characters of the document | `plannerAttachmentSummaryMax`, `plannerAttachmentSummaryInputMax` |
| One model call | 2,500 output tokens, 90 seconds | `apps/worker/src/fork/attachment-read.ts` |

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
| `PUT /attachments/:id/copy/:part` | One part of the file's reading copy (`audio-01.wav`…`audio-15.wav`, `frame-1.jpg`…`frame-6.jpg`), raw body up to 4 MB. 400 for any other part name. |
| `POST /attachments/:id/read` | Read again. 400 where reading is not set up, 409 while the file is `pending` (unless it has been for over 20 minutes since it was added: then the read is claimed again); else claims the read and answers the file as it stands. With `?first=1` it is the first read after a reading copy went up, and keeps to the task's store-only switch. |
| `PATCH /tasks/:id/attachments/settings` | `{files_read: boolean}`, the task's switch. |

A file over 10 MB (only audio and video may be) is streamed straight to R2
rather than held in the Worker's memory; its real size is checked once stored.
The upload puts the object first and records the row second; if the row fails
the object is deleted again, so the bucket never holds a file no task knows.

## The read

After an upload, where `ANTHROPIC_API_KEY` is set, the Worker claims a read
(`plannerClaimAttachmentRead`): the file goes `pending`, or `skipped` when the
task is store-only, or `capped` when the month's 200 are used. The read itself
(`forkReadAttachment`) goes on the Worker's queue (`DATA_EXPORT_QUEUE`, shared
with upstream's data export by message shape, as `{forkAttachmentRead:
{userId, attachmentId}}`), because a long recording is several Whisper calls
and a summary, and work left after a response is cut off 30 seconds later; the
consumer may run for 15 minutes (`apps/worker/src/fork/queue.ts`). Where there
is no queue (the tests) it runs after the response (`waitUntil`). The consumer
skips a file no longer `pending`, so a second delivery reads nothing. The panel
asks for the detail every three seconds while a file is pending. A file still
`pending` 20 minutes after it was added lost its read (`plannerAttachmentReadStale`),
and Read again takes it back instead of answering 409. A comment cut at its cap
ends on a whole line or sentence, with the cut mark. Text, email
and HTML are turned into text in the Worker (`packages/domain/src/planner/
attachment-text.ts`); when that text is under 5,000 characters it is the
comment, else it goes once to Claude's Messages API for a summary. A picture
or a PDF goes once as an image or document block, with one rule: write it out
in full when it fits, summarise when it does not, and say which on the first
line ("Text" or "Summary"), which the Worker turns into the comment's heading.
Both under `claude-sonnet-5-5` (`FLAREMO_ATTACHMENT_MODEL` overrides). The
result becomes a `comment_new` proposal with `{body, attachment_id, filename,
form}` and the file goes `read`; the day's proposal cap makes it `capped`, any
error `failed`. Read again on a file that
already has a card dismisses that card first, so a file shows one card. Nothing
of a file or its text is logged: only the kind and an error's status.

## Audio, video and iPhone photos

A Worker cannot decode sound or video, and Claude takes neither a HEIC photo
nor a picture over 5 MB, so for these the browser makes a **reading copy**
from the file it is uploading (`apps/web/src/planner/attachment-reading-copy.ts`):

- **Audio and video**: the sound is decoded at 16 kHz (an offline audio
  context resamples as it decodes), mixed to mono and cut into WAV parts of
  two minutes, at most 15 (30 minutes).
- **Video**: six JPEG frames taken evenly through it, at most 1,024 px.
- **HEIC, or a photo over about 3.75 MB**: one JPEG, at most 2,048 px.

The file itself is uploaded as it is, with `x-planner-reading-copy: 1`, so it
is stored but not read yet. The parts go up one by one
(`PUT /attachments/:id/copy/:part`) and sit beside the file under
`<file key>~read/<part>`; then the browser asks for the first read
(`POST /attachments/:id/read?first=1`). The row stays dimmed as
"uploading…" until all of that is done.

The read (`forkReadAttachment`) then:

- **Audio**: each WAV part goes to Whisper on Workers AI
  (`@cf/openai/whisper-large-v3-turbo`, the `AI` binding, no key of its own) and
  the words are joined. Under 5,000 characters they are the comment as said,
  headed "Transcript of <name>"; longer, Claude summarises them ("Summary of").
  A recording with no copy (sent by a script, or from a browser that could not
  decode it) goes to Whisper as it is when it is under 20 MB.
- **Video**: the sound is transcribed the same way, and the frames and the
  transcript go to Claude in one call, which says what the video shows and what
  is said in it ("What's in <name>"), or summarises when long.
- **Photo**: Claude reads the JPEG copy instead of the file. A HEIC with no copy
  is marked unreadable.

Every step in the browser is best effort. A browser that cannot decode a file
(a HEIC outside Safari, an unusual codec) leaves that part out; with no copy
at all the file is stored and Read stays on offer. Decoding holds the whole
sound in memory, so a recording longer than about two hours gets no sound
copy. Whisper's free allowance on Workers AI is 10,000 neurons a day, roughly
three hours of audio by Cloudflare's published prices (an estimate). The
nightly sweep deletes a file's reading copy with the file.

## Files in Ask my diary

The Ask my diary chat takes files too: a drop on the chat, a paste into the
question box, or the paperclip beside it (the only way on a phone). The chat is
about no task, so a file there is **not kept**. The browser makes the same
reading copy, uploads the file to `POST /chat-files` (stored under
`planner-chat/<user>/<id>/<name>`, its name in the object's metadata) and the
copy to `PUT /chat-files/:id/copy/:part`, then asks for the read with
`POST /chat-files/:id/read`. That read runs at once (a recording can take a
minute), answers the text with the same heading as a task's comment, and deletes
the file and its copy whether it was read or not.

The text waits in the page as a chip above the question box ("memo.m4a ·
read"), at most three a question, and goes with the next question as `files`
on `POST /ask` (each up to 5,400 characters). The agent gets the question with
each file's text after it, marked as the file's own words
(`plannerAgentQuestionWithFiles`); the chat shows and keeps only the question
and the files' names ("📎 memo.m4a"). Sending is held while a file is still being
read, and a question can be just the files. A task's own chat still puts files
on the task, as above. A chat file that was never read (the page closed
mid-upload) is deleted by the nightly sweep after a day. Chat reads do not count
toward the 200 task reads a month; the AI rate limit applies.

## Files in the review

Since November 2026 the review's Look back chat takes files the same way, for
the week and for the month, quarter and year chats: a drop on the answer box, a
paste into it, or the Upload button beside it (in the spot Talk had; Talk is
off by default). The button shows, with its label, in every stage after the
opening. It is live where the coach replies to the answer (last week's
question, the seven prompts, and the chat after the scores, with the coach on);
in the question for next Sunday, the verdict, or with the coach off it is
greyed out and its title says where files go. The coach is told
(`PLANNER_COACH_FILES_RULE`, weekly and period) that it may ask once a prompt
for proof as a file, such as a contract or an offer, when the diary does not
settle the point. Each file goes through the same chat-file routes as Ask
(upload, reading copy, read at once, file deleted), at most three an answer,
and waits as a line above the box until the answer is sent. An answer can be
just the files.

The coach request (`POST /review/:week/ai/coach`, and the period chat's
`…/chat/ai/coach`) carries them as `files`, each `{ filename, text }` up to
5,400 characters (`plannerAiCoachSchema`). With the agent, the coach step's
message gets each file's text after the chat, marked as the file's own words
(`plannerAgentQuestionWithFiles(…, "answer")`); the session keeps it, so the
scores and the memo can use it too. Without the agent, the fallback model gets
the files on the latest answer for that one reply only
(`plannerReviewChatWithFiles`): the chat keeps just the names, so later
replies, the scores and the memo never see the text. Keeping it would put the
file's text in the saved review state, which the review avoids. The chat shows and the review keeps only the
answer and the files' names ("📎 run.pdf", `plannerAnswerWithFiles`), so the
saved answers never hold a file's text.


`read_task` ends with a Files block: one line per file with its name, type,
size, when it was added and its state in words. A read file whose card is still
open has its text indented under its line, so the agent can work from the
owner's file before the owner accepts anything; once accepted, the text is a
comment and only the comment is shown. The agent's prompt (the Ask chat's
task line in `agent-prompts.ts`) and the `ask-my-diary` skill say what that
means: the text is the file's own words, not a comment until accepted, and a
file "being read" was just dropped, so the agent reads again once before it
answers. A prompt or skill change needs `scripts/fork/general-agent.ts` re-run
against dev, then live.

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
| `packages/domain/src/planner/attachment-text.ts` | What kind a file is; whole or summary; the comment heading; an email and a web page as text. |
| `packages/domain/src/planner/agent-apply.ts` | Accepting `comment_new` writes the comment. |
| `packages/domain/src/planner/agent-tools.ts` | `read_task` lists the files, their state and the text of an open card. |
| `packages/domain/src/planner/agent-prompts.ts`, `skills/ask-my-diary/SKILL.md` | What the agent is told about files in a task's chat. |
| `apps/worker/src/routes/planner-attachments-api.ts` | The six routes. |
| `apps/worker/src/fork/task-attachments.ts` | Serving a file; the nightly purge. |
| `apps/worker/src/fork/attachment-read.ts` | The read, started on the queue; the one Messages API call for pictures and PDFs. |
| `apps/worker/src/fork/queue.ts` | The fork's messages on the Worker's queue: a task file's read. |
| `apps/web/src/planner/task-panel-attachments.tsx` | The panel section: the list, the states, the card under a file, Read again, the switch. |
| `apps/web/src/planner/use-chat-files.ts` | Files dropped in Ask my diary: read at once, held as chips, sent with the question. |
| `apps/web/src/planner/attachment-reading-copy.ts` | The reading copy made in the browser: sound as WAV parts, video frames, a photo as JPEG. |
| `apps/web/src/planner/use-attachment-actions.ts` | The upload queue, remove, read again, the switch and the state words, shared by the panel and the chat. |
| `apps/web/src/planner/ask-chat.tsx` | `PlannerProposalCard`, shared with the chat, renders a proposed comment; a task's chat takes dropped and pasted files. |
| `apps/web/src/planner/api.ts`, `strings.ts`, `history-labels.ts` | The client calls, the words (en and zh-CN), the History labels. |

Tests: `packages/domain/src/planner/attachments.test.ts`,
`packages/domain/src/planner/attachment-text.test.ts`,
`apps/worker/src/routes/planner-attachments-api.test.ts`,
`apps/web/src/planner/task-panel-attachments.test.tsx`,
`apps/web/src/planner/ask-chat.test.tsx`.

## Undoing it

Remove the files in the table above and the hook-in lines (the planner route
mount, the nightly call, the panel section, the `comment_new` case in
`agent-apply.ts`, the Files block in `agent-tools.ts`, the drop and paste
handlers in `ask-chat.tsx`, the files line in the agent prompt and skill). The table and column
stay; fork migrations are never rolled back. Objects under `planner/` in the
bucket can be deleted by prefix. Open `comment_new` proposals expire with the
agent's seven-day sweep.
