/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Memo editing (docs/fork-customizations.md, section 17) rests on small
// hook-ins in upstream files. After an upstream sync that drops one, this
// fails loudly instead of Edit quietly wiping hidden tags again.

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("the memo editing hook-ins", () => {
  it("the card starts Edit with hidden tags and saves file changes", () => {
    const text = read("../components/memo-card.tsx");
    expect(text).toContain("setDraftContent(forkEditDraftContent(memo))");
    expect(text).toContain("useForkEditFiles(memo, attachments)");
    expect(text).toContain("onSave={forkSave}");
  });

  it("the edit box shows tag chips, file chips and Add file", () => {
    const text = read("../components/memo-card/memo-card-editor.tsx");
    expect(text).toContain("<ForkEditTagChips");
    expect(text).toContain("<ForkEditFileChips");
    expect(text).toContain("<ForkEditAddFileButton");
  });

  it("a failed upload keeps the saved note out of the offline queue", () => {
    expect(read("../lib/memo-submission.ts")).toContain(
      "throw new ForkAttachmentUploadError(",
    );
    expect(read("../components/workspace-composer.tsx")).toContain(
      "error instanceof ForkAttachmentUploadError",
    );
  });
});
