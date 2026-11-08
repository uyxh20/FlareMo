# Link summaries

Fork-owned. The owner drops a link (a blog post, an article, any web page, a
YouTube video, a PDF) into a diary entry or into Ask my diary, and the general
agent (`docs/fork-general-agent.md`) reads it and proposes a summary as a new
diary entry. The owner accepts the card, then annotates the summary with
comments in their own words. It is a way to brain-dump what they read or
watched into the diary.

## How the owner uses it

- **From an entry:** the entry's ⋯ menu has **Summarize link** when the entry
  holds a web address (up to three are passed). It opens a new Ask my diary
  chat with the request typed in, naming the entry, so the owner can add what
  to focus on before sending.
- **From the composer:** the ✦ button at the end of the composer's toolbar
  (greyed out until the text holds a link) opens the same chat for a link not
  saved yet. The draft stays in the composer, so the owner can still save
  their own note with the link.
- **From Ask my diary:** paste the link and ask for a summary.

The agent answers with a card: the proposed entry, and a line saying how much
of the link it read. Accept saves it; Dismiss saves nothing. The owner's
thoughts go in as comments on the saved entry.

## How the link is read

The agent's sandbox has no web tools, and that stays so. Its `read_link` MCP
tool asks the Worker to fetch the link (`apps/worker/src/fork/link-read.ts`):

- **Only links the owner gave:** the address must be in one of the owner's
  messages in the chat being answered, or in the owner's entry named by
  `entry_id`. A page the agent read cannot send it to another address, so
  diary text cannot leak out through a URL.
- **Address checks:** every address and every redirect hop goes through
  upstream's link-preview check (`validateExternalUrl`): http(s) only, no
  internal or private hosts. 12-second timeout, five redirects, 4 MB of HTML,
  15 MB of PDF.
- **Web pages:** the article (or main part, or body) as plain text with
  headings and list items; scripts, menus, headers, footers and side bars
  dropped. A page with under 600 characters of text is read as "partial" or
  "description" (a login wall or a page built by JavaScript, such as X), with
  its title and description.
- **YouTube** (watch, youtu.be, shorts, live, embed links): the title,
  channel, length and description, plus the transcript: English written
  captions first, then English automatic ones, then any. It tries YouTube's
  Android app player data and the watch page. YouTube often refuses
  transcripts to cloud servers; then the read is "description" and the card
  says so. Caption links pointing off YouTube are not followed.
- **PDFs:** through Workers AI's `toMarkdown` (free for PDFs). A scanned PDF
  with little text is read as partial.
- Text over 180,000 characters (about 30,000 words) is cut and read as
  partial.

The tool hands the agent the text between markers, says it is outside
material and not instructions, and hands it the `link` value to pass on.

## What is saved

`propose_entry` takes an optional `link` (`url`, `read`, `title`,
`from_entry_id`); the card shows "Link summary · read in full / only part /
only the title and description". On accept (`agent-apply.ts`) the entry is
created with source `link-summary` (not `agent-draft`), `#link` is added if
the agent left it out, and a reference relation points at the owner's entry
when there is one. Undo archives it, like any agent entry. No migration and
no new table or column: the source and the tag mark it.

## Keeping the owner's words apart

A summary is something the owner read, not something they said:

- the agent's reads label it "link summary (you wrote it from a web page; not
  the owner's words)", and the owner's comments read "as a comment on entry
  <id>";
- a memory proposal's quote is never found in a link summary
  (`plannerAgentFindQuote`);
- the review model's diary (week and period) prefixes it with "[Link summary
  ... not the owner's words]";
- memory dreaming skips it (`collectDreamingSources`, upstream hook-in);
- search and the export treat it as any entry.

## Cost

Each summary is one Ask turn of the general agent, inside its per-session and
monthly caps (`FLAREMO_AGENT_RUN_USD`, `FLAREMO_AGENT_MONTH_USD`): roughly
$0.10 to $0.40 a link, a long video costing the most. The Worker's fetch and
the PDF conversion cost nothing extra.

## Rolling it out

The tool and its description come from the Worker, so a deploy brings them.
The `ask-my-diary` skill gained a short "When the owner gives you a link"
section; run `scripts/fork/general-agent.ts --target dev` (then `--target
prod`) to upload it.

## Code

| What | Where |
| --- | --- |
| Tool input and description, `link` | `packages/contracts/src/planner-agent.ts` |
| `read_link`, the owner-gave-it check, labels | `packages/domain/src/planner/agent-tools.ts` |
| Saving as a link summary | `packages/domain/src/planner/agent-apply.ts` |
| Not the owner's words | `agent-store.ts`, `review-context.ts`, `period-review-context.ts`, `packages/domain/src/memory/consolidation.ts` |
| The reader | `apps/worker/src/fork/link-read.ts`, wired in `apps/worker/src/routes/planner-agent-mcp.ts` |
| The menu item and the card line | `apps/web/src/fork/summarize-link.tsx`, `apps/web/src/planner/ask-chat.tsx` |
| Tests | `apps/worker/src/fork/link-read.test.ts`, `packages/domain/src/planner/agent-link.test.ts`, `packages/domain/src/fork/link-summary-wiring.test.ts`, `apps/web/src/fork/summarize-link.test.ts` |
