/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Backdating a memo and showing a long memo in full rest on small hook-ins in
// upstream files. After an upstream sync that drops one, this fails loudly
// instead of the menu entry vanishing, the server ignoring created_at, or long
// memos being cut off at 1,600px again. See docs/fork-customizations.md.

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

describe("the memo date and expanded-height hook-ins", () => {
  it("memo-card-menu.tsx renders the fork menu item and dialog", () => {
    const text = read("../components/memo-card/memo-card-menu.tsx");
    expect(text).toMatch(/from "@\/fork\/memo-date-dialog"/);
    expect(text).toMatch(
      /<ForkMemoDateMenuItem\s+onSelect=\{\(\) => setForkDateOpen\(true\)\}/,
    );
    expect(text).toMatch(
      /<ForkMemoDateDialog\s+memo=\{memo\}\s+open=\{forkDateOpen\}\s+onOpenChange=\{setForkDateOpen\}/,
    );
  });

  it("memo-card-body.tsx has no height cap once expanded", () => {
    const text = read("../components/memo-card/memo-card-body.tsx");
    expect(text).toContain('collapsed ? "max-h-52" : "max-h-none"');
    expect(text).not.toContain("max-h-[1600px]");
  });

  it("the shared memo update schema accepts created_at", () => {
    const text = read("../../../../packages/contracts/src/memos.ts");
    expect(text).toMatch(
      /created_at: z\.string\(\)\.datetime\(\{ offset: true \}\)\.optional\(\),/,
    );
  });

  it("updateMemo applies the backdate through the fork module", () => {
    const text = read("../../../../packages/domain/src/memos-write.ts");
    expect(text).toMatch(
      /import \{ forkApplyBackdate \} from "\.\/fork\/memo-backdate"/,
    );
    expect(text).toMatch(/input\.created_at !== undefined\s*\)/);
    expect(text).toMatch(
      /forkApplyBackdate\(\s*existing,\s*input\.created_at,/,
    );
    expect(text).toMatch(/createdAt: backdate\.createdAt,/);
    expect(text).toMatch(
      /\.\.\.\(backdate\.changed \? \{ createdAt: backdate\.createdAt \} : \{\}\)/,
    );
    expect(text).toMatch(/metadataChanged \|\| backdate\.changed/);
  });
});
