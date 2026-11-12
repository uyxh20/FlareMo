import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// A task's notes and comments drawn as Markdown (fork-owned add-on,
// docs/fork-customizations.md, "Task notes and comments as Markdown"). The text
// stays plain text, saved exactly as typed: this only draws it. One source line
// is one row, so a ticked box maps straight back to its line, and everything is
// built as React elements, never as HTML, so nothing in a note can run.
//
// What it understands, chosen for how plans are written in the cockpit:
// - `- [ ]` / `- [x]` to-dos (ticking rewrites that one line), `-`/`*` bullets,
//   `1.` numbered items, two spaces of indent per level;
// - `#`, `##`, `###` headings, and a "smart section": a numbered line with no
//   indent sitting straight above a list ("1. Inbox pilot" then "- [ ] …") is a
//   heading, since that is how plans are written here;
// - in notes, the first line of a note with three or more lines is its title;
// - a short "Label:" opening a line ("Aim:", "Source:") is bold;
// - `> quote`, `---`, **bold**, *italics* / _italics_, `code`, [links](https://…)
//   and bare https:// addresses.

export type PlannerMarkdownLine =
  | { kind: "blank" }
  | { kind: "rule" }
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "section"; number: string; text: string }
  | { kind: "title"; text: string }
  | { kind: "todo"; indent: number; done: boolean; text: string }
  | { kind: "bullet"; indent: number; text: string }
  | { kind: "numbered"; indent: number; number: string; text: string }
  | { kind: "quote"; text: string }
  | { kind: "text"; label: string | null; text: string };

const HEADING = /^(#{1,3})\s+(.*)$/;
const TODO = /^(\s*)[-*+]\s+\[( |x|X)\](?:\s+(.*))?$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const LABEL = /^(\p{Lu}[\p{L}\p{N} ]{0,18}):\s+(.*)$/u;

const indentOf = (space: string) =>
  Math.min(6, Math.floor(space.replace(/\t/g, "  ").length / 2));

/** Each line of `source`, read as one row. */
export function plannerMarkdownLines(
  source: string,
  options: { title?: boolean } = {},
): PlannerMarkdownLine[] {
  const lines = source.replace(/\r/g, "").split("\n");
  const filled = lines.filter((line) => line.trim() !== "").length;
  const titleAt =
    options.title && filled >= 3
      ? lines.findIndex((line) => line.trim() !== "")
      : -1;
  return lines.map((raw, index): PlannerMarkdownLine => {
    const line = raw.replace(/\s+$/, "");
    if (line.trim() === "") return { kind: "blank" };
    if (RULE.test(line)) return { kind: "rule" };
    let match = HEADING.exec(line);
    if (match) {
      return {
        kind: "heading",
        level: match[1].length as 1 | 2 | 3,
        text: match[2],
      };
    }
    match = TODO.exec(line);
    if (match) {
      return {
        kind: "todo",
        indent: indentOf(match[1]),
        done: match[2] !== " ",
        text: match[3] ?? "",
      };
    }
    match = BULLET.exec(line);
    if (match) {
      return { kind: "bullet", indent: indentOf(match[1]), text: match[2] };
    }
    match = NUMBERED.exec(line);
    if (match) {
      const next = lines[index + 1] ?? "";
      const previous = lines[index - 1] ?? "";
      if (
        match[1] === "" &&
        (TODO.test(next) || BULLET.test(next)) &&
        !NUMBERED.test(previous)
      ) {
        return { kind: "section", number: match[2], text: match[3] };
      }
      return {
        kind: "numbered",
        indent: indentOf(match[1]),
        number: match[2],
        text: match[3],
      };
    }
    match = QUOTE.exec(line);
    if (match) return { kind: "quote", text: match[1] };
    if (index === titleAt) return { kind: "title", text: line.trim() };
    match = LABEL.exec(line);
    if (match) return { kind: "text", label: match[1], text: match[2] };
    return { kind: "text", label: null, text: line };
  });
}

/** `source` with the to-do on line `index` ticked or unticked; anything else is left as it is. */
export function plannerToggleMarkdownTodo(
  source: string,
  index: number,
): string {
  const lines = source.split("\n");
  const line = lines[index];
  if (line === undefined) return source;
  lines[index] = line.replace(
    /^(\s*[-*+]\s+\[)( |x|X)(\])/,
    (_all, open: string, mark: string, close: string) =>
      `${open}${mark === " " ? "x" : " "}${close}`,
  );
  return lines.join("\n");
}

// --- Inline: code, links, bold, italics ----------------------------------------

const INLINE =
  /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"])|\*\*([^*]+)\*\*|(?<![\p{L}\p{N}*_])[*_]([^*_\s](?:[^*_]*[^*_\s])?)[*_](?![\p{L}\p{N}*_])/gu;

/** One line's inline Markdown, as React nodes. */
export function plannerMarkdownInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, code, linkText, linkUrl, bare, bold, italic] = match;
    key += 1;
    if (code !== undefined) {
      out.push(
        <code
          className="rounded bg-muted px-1 py-px font-mono text-[0.85em]"
          key={key}
        >
          {code}
        </code>,
      );
    } else if (linkText !== undefined || bare !== undefined) {
      out.push(
        <a
          className="text-primary underline underline-offset-2 break-all"
          href={linkUrl ?? bare}
          key={key}
          rel="noopener noreferrer"
          target="_blank"
        >
          {linkText ?? bare}
        </a>,
      );
    } else if (bold !== undefined) {
      out.push(
        <strong className="font-semibold" key={key}>
          {plannerMarkdownInline(bold)}
        </strong>,
      );
    } else if (italic !== undefined) {
      out.push(<em key={key}>{italic}</em>);
    } else {
      out.push(whole);
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// --- Rows ----------------------------------------------------------------------

const indentStyle = (indent: number) =>
  indent > 0 ? { paddingInlineStart: `${indent * 1.375}rem` } : undefined;

function Row({
  line,
  index,
  onToggle,
}: {
  line: PlannerMarkdownLine;
  index: number;
  onToggle?: (index: number) => void;
}) {
  switch (line.kind) {
    case "blank":
      return <div aria-hidden className="h-2" />;
    case "rule":
      return <hr className="my-2 border-border" />;
    case "title":
      return (
        <p className="mb-0.5 text-[15px] font-semibold">
          {plannerMarkdownInline(line.text)}
        </p>
      );
    case "heading": {
      const Tag = line.level === 1 ? "h4" : line.level === 2 ? "h5" : "h6";
      return (
        <Tag
          className={cn(
            "mt-2 mb-0.5 font-semibold",
            line.level === 1 && "text-base",
            line.level === 2 && "text-[15px]",
            line.level === 3 && "text-sm text-muted-foreground",
          )}
        >
          {plannerMarkdownInline(line.text)}
        </Tag>
      );
    }
    case "section":
      return (
        <h5 className="mt-2 mb-0.5 flex items-baseline gap-2 text-[15px] font-semibold">
          <span className="inline-flex h-5 min-w-5 flex-none -translate-y-px items-center justify-center rounded-md bg-primary/12 px-1 text-xs font-bold text-primary tabular-nums">
            {line.number}
          </span>
          <span>{plannerMarkdownInline(line.text)}</span>
        </h5>
      );
    case "todo":
      return (
        <div
          className="my-0.5 flex items-start gap-2"
          data-testid="planner-md-todo"
          style={indentStyle(line.indent)}
        >
          <input
            aria-label={line.text || "To-do"}
            checked={line.done}
            className="task-checkbox mt-[3px] flex-none"
            disabled={!onToggle}
            type="checkbox"
            onChange={() => onToggle?.(index)}
            onClick={(event) => event.stopPropagation()}
          />
          <span
            className={cn(
              "min-w-0",
              line.done &&
                "text-muted-foreground line-through decoration-muted-foreground/60",
            )}
          >
            {plannerMarkdownInline(line.text)}
          </span>
        </div>
      );
    case "bullet":
      return (
        <div className="my-0.5 flex gap-2" style={indentStyle(line.indent)}>
          <span
            aria-hidden
            className="w-[15px] flex-none text-center text-muted-foreground/70"
          >
            •
          </span>
          <span className="min-w-0">{plannerMarkdownInline(line.text)}</span>
        </div>
      );
    case "numbered":
      return (
        <div className="my-0.5 flex gap-2" style={indentStyle(line.indent)}>
          <span className="w-[15px] flex-none text-right text-muted-foreground tabular-nums">
            {line.number}.
          </span>
          <span className="min-w-0">{plannerMarkdownInline(line.text)}</span>
        </div>
      );
    case "quote":
      return (
        <p className="my-1 border-s-2 border-primary/45 ps-3 text-muted-foreground">
          {plannerMarkdownInline(line.text)}
        </p>
      );
    case "text":
      return (
        <p>
          {line.label !== null && (
            <span className="font-semibold">{line.label}: </span>
          )}
          {plannerMarkdownInline(line.text)}
        </p>
      );
  }
}

/**
 * `text` drawn as Markdown. With `onToggle`, to-do boxes can be ticked: it gets
 * the whole text with that one line changed.
 */
export function PlannerTaskMarkdown({
  text,
  title = false,
  onToggle,
  className,
}: {
  text: string;
  /** Whether the first line of a longer text is drawn as its title (notes). */
  title?: boolean;
  onToggle?: (next: string) => void;
  className?: string;
}) {
  const lines = plannerMarkdownLines(text, { title });
  // Blank lines at either end draw nothing.
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].kind === "blank") start += 1;
  while (end > start && lines[end - 1].kind === "blank") end -= 1;
  const toggle = onToggle
    ? (index: number) => onToggle(plannerToggleMarkdownTodo(text, index))
    : undefined;
  return (
    <div
      className={cn("text-sm leading-relaxed break-words", className)}
      data-testid="planner-markdown"
    >
      {lines.slice(start, end).map((line, offset) => {
        const index = start + offset;
        return (
          // One row per source line: the line number is the row's identity.
          <Row index={index} key={index} line={line} onToggle={toggle} />
        );
      })}
    </div>
  );
}
