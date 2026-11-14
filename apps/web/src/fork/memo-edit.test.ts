// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { buildComposerExtensions } from "@/components/rich-composer-editor";
import { extractTags } from "@/lib/memo";
import {
  forkAddTag,
  forkCleanTagName,
  forkEditDraftContent,
  forkRemoveTag,
  forkRenameTag,
  forkTagsOutsideText,
} from "./memo-edit";

const memo = (content: string, tags?: string[]) => ({
  content,
  payload: tags ? { tags } : {},
});

describe("hidden tags join the edit text", () => {
  it("lists only tags the text does not spell out", () => {
    expect(
      forkTagsOutsideText(memo("Stand day #vipex", ["carlsberg", "vipex"])),
    ).toEqual(["carlsberg"]);
  });

  it("writes hidden tags as the last line, so Save keeps them", () => {
    const draft = forkEditDraftContent(
      memo("VIPEX day\n\nRan a stand.\n", ["carlsberg", "vipex"]),
    );
    expect(draft).toBe("VIPEX day\n\nRan a stand.\n\n#carlsberg #vipex");
    expect(extractTags(draft).sort()).toEqual(["carlsberg", "vipex"]);
  });

  it("leaves a note with no hidden tags alone", () => {
    expect(forkEditDraftContent(memo("Gym #fitness", ["fitness"]))).toBe(
      "Gym #fitness",
    );
    expect(forkEditDraftContent(memo("Plain"))).toBe("Plain");
  });

  it("keeps hierarchical tags whole", () => {
    expect(forkEditDraftContent(memo("x", ["work/project-a"]))).toBe(
      "x\n\n#work/project-a",
    );
  });

  it("survives the editor's markdown round trip as tags", () => {
    const editor = new Editor({
      extensions: buildComposerExtensions(""),
      content: forkEditDraftContent(
        memo("VIPEX day\n\n- one\n- two", ["carlsberg", "vipex"]),
      ),
      contentType: "markdown",
    });
    const saved = editor.getMarkdown();
    expect(extractTags(saved).sort()).toEqual(["carlsberg", "vipex"]);
    editor.destroy();
  });
});

describe("editing tags by hand", () => {
  it("removes a tag everywhere, whole words only", () => {
    expect(forkRemoveTag("Talk #ai about #aim\n\n#ai #link", "ai")).toBe(
      "Talk about #aim\n\n#link",
    );
  });

  it("drops a tags line that becomes empty", () => {
    expect(forkRemoveTag("Note\n\n#vipex", "vipex")).toBe("Note");
  });

  it("renames a tag, case-insensitively, keeping what is around it", () => {
    expect(forkRenameTag("A (#AI) and #ai/tools\n#ai", "ai", "llm")).toBe(
      "A (#llm) and #ai/tools\n#llm",
    );
  });

  it("refuses a rename to something that is not a tag", () => {
    expect(forkRenameTag("x #ai", "ai", "two words")).toBe("x #ai");
    expect(forkCleanTagName("#Design")).toBe("design");
    expect(forkCleanTagName("a b")).toBeUndefined();
  });

  it("adds to a trailing tags line, or starts one", () => {
    expect(forkAddTag("Note\n\n#a #b", "c")).toBe("Note\n\n#a #b #c");
    expect(forkAddTag("Note text", "c")).toBe("Note text\n\n#c");
    expect(forkAddTag("Note #c", "c")).toBe("Note #c");
  });
});
