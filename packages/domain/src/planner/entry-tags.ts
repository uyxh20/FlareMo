import { extractTags, normalizeTag } from "../tags";

// A diary entry's #tags added or taken away (fork-owned add-on,
// docs/fork-general-agent.md, "Whose words"): tags are values, so the agent may
// propose them; the server puts them in, and no other word of the entry moves.
// Tags are read as upstream reads them (`extractTags`): lowercased paths.

const TAG_CHAR = "[\\p{L}\\p{N}_\\-/]";

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A line that holds only #tags. */
const tagLine = (line: string) =>
  line.trim().length > 0 &&
  line
    .trim()
    .split(/\s+/)
    .every((word) => new RegExp(`^#${TAG_CHAR}+$`, "u").test(word));

export type PlannerEntryRetag =
  | { content: string; added: string[]; removed: string[] }
  | { refused: string };

/**
 * The entry with `add` tags put in and `remove` tags taken out. A new tag goes
 * at the end of a last line of tags, else on a line of its own; a removed one
 * leaves the words around it, and a line it leaves empty goes. Refuses a tag
 * the entry already has (add) or lacks (remove), and a change that is no change.
 */
export function plannerEntryRetag(
  content: string,
  input: { add: readonly string[]; remove: readonly string[] },
): PlannerEntryRetag {
  const have = new Set(extractTags(content));
  const norm = (values: readonly string[]) => [
    ...new Set(
      values.map((value) => normalizeTag(value)).filter(Boolean) as string[],
    ),
  ];
  if ([...input.add, ...input.remove].some((value) => !normalizeTag(value))) {
    return { refused: "One of the tags is not a tag." };
  }
  const add = norm(input.add);
  const remove = norm(input.remove);
  const both = add.filter((tag) => remove.includes(tag));
  if (both.length > 0) {
    return { refused: `#${both[0]} is both added and removed.` };
  }
  const already = add.filter((tag) => have.has(tag));
  if (already.length > 0) {
    return {
      refused: `The entry already has #${already[0]}. Nothing was proposed.`,
    };
  }
  const missing = remove.filter((tag) => !have.has(tag));
  if (missing.length > 0) {
    return {
      refused: `The entry has no #${missing[0]}. Nothing was proposed.`,
    };
  }

  let lines = content.split("\n");
  for (const tag of remove) {
    const pattern = new RegExp(
      `(^|[^\\p{L}\\p{N}_\\-/])#${escapeRegExp(tag)}(?!${TAG_CHAR})`,
      "giu",
    );
    lines = lines.flatMap((line) => {
      if (!pattern.test(line)) return [line];
      pattern.lastIndex = 0;
      const next = line
        .replace(pattern, (_match, before: string) => before)
        .replace(/[ \t]{2,}/g, " ")
        .trimEnd();
      return next.trim().length === 0 ? [] : [next];
    });
  }
  if (add.length > 0) {
    const words = add.map((tag) => `#${tag}`).join(" ");
    while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
      lines.pop();
    }
    const last = lines[lines.length - 1];
    if (last !== undefined && tagLine(last)) {
      lines[lines.length - 1] = `${last.trimEnd()} ${words}`;
    } else {
      lines.push(words);
    }
  }
  const next = lines.join("\n");
  if (next.trim() === content.trim() || !next.trim()) {
    return { refused: "That leaves the entry as it is. Nothing was proposed." };
  }
  return { content: next, added: add, removed: remove };
}
