import { Fragment, type ReactNode } from "react";

// The summary memo drawn as the memo sheet shows it (fork-owned add-on,
// docs/planning-cockpit-goals-review.md): the small part of Markdown the weekly
// summaries use (headings, paragraphs, lists, one table, rules, bold, italics and
// code) as React elements, never as HTML, so nothing in the memo can run. While
// the model is still writing, a half-typed last line is held back and a cursor
// blinks at the end.

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; level: 1 | 2 | 3 | 4; text: string }
  | { kind: "hr" }
  | {
      kind: "list";
      ordered: boolean;
      items: Array<{ text: string; sub: boolean; value?: number }>;
    }
  | { kind: "table"; rows: string[] }
  | { kind: "diary"; from: string; to: string };

type ListBlock = Extract<Block, { kind: "list" }>;

const DIARY =
  /^\s*<!--\s*flaremo:diary\s+(\d{4}-\d\d-\d\d)\.\.(\d{4}-\d\d-\d\d)\s*-->$/;
const COMMENT = /^\s*<!--[\s\S]*-->$/;
const DIARY_LINE = /^Diary entries from .+\.$/;
// While the memo streams: a last line that is only a marker so far, or a
// comment not closed yet (the diary marker comes last), which would otherwise
// flash on screen as text.
const UNFINISHED_MARKER =
  /^\s*(#{1,6}|[-*+]|--|\*\*|__?|\d+[.)]|\||<!?-{0,2})?\s*$/;
const UNFINISHED_COMMENT = /^\s*<!--(?![\s\S]*-->)/;

/** The memo's blocks. `live` drops a last line that is not readable yet. */
export function plannerMarkdownBlocks(markdown: string, live = false): Block[] {
  const lines = markdown.replace(/\r/g, "").split("\n");
  const last = lines.at(-1) ?? "";
  if (live && (UNFINISHED_MARKER.test(last) || UNFINISHED_COMMENT.test(last))) {
    lines.pop();
  }
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  // Typed through `as` so the flushes, which reset it from a closure, do not
  // leave it narrowed to null inside the loop.
  let list = null as ListBlock | null;
  let table: string[] | null = null;
  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "p", lines: paragraph });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list);
    list = null;
  };
  const flushTable = () => {
    if (table) blocks.push({ kind: "table", rows: table });
    table = null;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const diary = DIARY.exec(line);
    if (diary) {
      flushAll();
      // The template writes a plain line about the diary right above the
      // marker; the marker's own chip says the same.
      const previous = blocks.at(-1);
      if (
        previous?.kind === "p" &&
        previous.lines.length === 1 &&
        DIARY_LINE.test(previous.lines[0] ?? "")
      ) {
        blocks.pop();
      }
      blocks.push({ kind: "diary", from: diary[1] ?? "", to: diary[2] ?? "" });
      continue;
    }
    if (COMMENT.test(line)) continue;
    if (/^\s*\|/.test(line)) {
      flushParagraph();
      flushList();
      table ??= [];
      table.push(line);
      continue;
    }
    flushTable();
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1]?.length ?? 1, 4) as 1 | 2 | 3 | 4;
      blocks.push({ kind: "h", level, text: heading[2] ?? "" });
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "hr" });
      continue;
    }
    const item = /^(\s*)([-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      const ordered = item[3] !== undefined;
      const sub = (item[1]?.length ?? 0) >= 2;
      if (!list || (list.ordered !== ordered && !sub)) {
        flushList();
        list = { kind: "list", ordered, items: [] };
      }
      list.items.push({
        text: item[4] ?? "",
        sub,
        ...(ordered && !sub ? { value: Number(item[3]) } : {}),
      });
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushAll();
  return blocks;
}

const INLINE =
  /`([^`]+)`|\*\*([^*]+)\*\*|(^|[\s(])\*([^*\s][^*]*)\*|(^|[\s(])_([^_\s][^_]*)_/g;

/** Bold, italics and code inside a line. */
export function plannerInlineMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    const [, code, strong, starLead, star, lineLead, line] = match;
    if (code !== undefined) {
      out.push(<code key={key++}>{code}</code>);
    } else if (strong !== undefined) {
      out.push(<strong key={key++}>{strong}</strong>);
    } else if (star !== undefined) {
      if (starLead) out.push(starLead);
      out.push(<em key={key++}>{star}</em>);
    } else if (line !== undefined) {
      if (lineLead) out.push(lineLead);
      out.push(<em key={key++}>{line}</em>);
    }
    last = start + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function cells(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

const isSeparator = (row: string) =>
  cells(row).every((cell) => /^:?-+:?$/.test(cell));

function Table({ rows }: { rows: string[] }) {
  let head: string[] | null = null;
  let align: Array<"left" | "right" | "center" | undefined> = [];
  let body = rows;
  if (rows.length >= 2 && isSeparator(rows[1] ?? "")) {
    head = cells(rows[0] ?? "");
    align = cells(rows[1] ?? "").map((cell) =>
      /^:-+:$/.test(cell) ? "center" : /-:$/.test(cell) ? "right" : undefined,
    );
    body = rows.slice(2);
  }
  return (
    <div className="planner-md-table">
      <table>
        {head && (
          <thead>
            <tr>
              {head.map((cell, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: table cells have no ids
                <th key={index} style={{ textAlign: align[index] }}>
                  {plannerInlineMarkdown(cell)}
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          {body
            .filter((row) => !isSeparator(row))
            .map((row, rowIndex) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: table rows have no ids
              <tr key={rowIndex}>
                {cells(row).map((cell, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: table cells have no ids
                  <td key={index} style={{ textAlign: align[index] }}>
                    {plannerInlineMarkdown(cell)}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

export function PlannerMarkdown({
  markdown,
  live = false,
  diaryLabel,
}: {
  markdown: string;
  live?: boolean;
  /** The chip shown where the week's diary entries are linked. */
  diaryLabel: (from: string, to: string) => string;
}) {
  const blocks = plannerMarkdownBlocks(markdown, live);
  const cursor = live ? <span className="planner-md-cursor" /> : null;
  return (
    <div className="planner-md">
      {blocks.map((block, index) => {
        const tail = index === blocks.length - 1 ? cursor : null;
        // Blocks have no ids; the memo is drawn again whole as it streams.
        const key = index;
        switch (block.kind) {
          case "h": {
            const Heading = `h${block.level}` as const;
            return (
              <Heading key={key}>
                {plannerInlineMarkdown(block.text)}
                {tail}
              </Heading>
            );
          }
          case "p":
            return (
              <p key={key}>
                {block.lines.map((line, lineIndex) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: lines have no ids
                  <span key={lineIndex}>
                    {lineIndex > 0 && <br />}
                    {plannerInlineMarkdown(line)}
                  </span>
                ))}
                {tail}
              </p>
            );
          case "hr":
            return (
              <Fragment key={key}>
                <hr />
                {tail}
              </Fragment>
            );
          case "list": {
            const List = block.ordered ? "ol" : "ul";
            return (
              <List key={key}>
                {block.items.map((item, itemIndex) => (
                  <li
                    data-sub={item.sub ? "" : undefined}
                    // biome-ignore lint/suspicious/noArrayIndexKey: list items have no ids
                    key={itemIndex}
                    value={item.value}
                  >
                    {plannerInlineMarkdown(item.text)}
                    {itemIndex === block.items.length - 1 && tail}
                  </li>
                ))}
              </List>
            );
          }
          case "table":
            return (
              <div key={key}>
                <Table rows={block.rows} />
                {tail}
              </div>
            );
          case "diary":
            return (
              <p key={key}>
                <span className="planner-md-diary">
                  {diaryLabel(block.from, block.to)}
                </span>
                {tail}
              </p>
            );
          default:
            return null;
        }
      })}
      {blocks.length === 0 && cursor}
    </div>
  );
}
