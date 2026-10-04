import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain-JS modules without types
import {
  collectCodexMemories,
  collectZcodeMemories,
  parseZcodeFrontmatter,
  redact,
} from "../../harness/core/importer.mjs";
import { tmpHome, writeFile } from "./helpers";

interface ImportItem {
  label: string;
  args: {
    content: string;
    scope_type: string;
    scope_key?: string;
    source_session?: string;
    tags: string[];
    idempotency_key: string;
    evidence: { source_id: string; excerpt: string }[];
  };
}

const h16 = (p: string) =>
  createHash("sha256").update(p).digest("hex").slice(0, 16);

describe("redact", () => {
  it("replaces all secret shapes with [REDACTED_SECRET]", () => {
    const cases = [
      "token memos_pat_abc123xyz",
      "key sk-abcdefghijklmnop1234",
      "ghp_abcdefghijklmnopqrstuvwx",
      "github_pat_11AAAABBBCCC",
      "aws AKIAIOSFODNN7EXAMPLE",
      "slack xoxb-1234-5678-abc",
      "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
      "password: hunter2",
      "token=abcdef123",
    ];
    for (const c of cases) {
      const out = redact(c);
      expect(out).toContain("[REDACTED_SECRET]");
      expect(out).not.toMatch(
        /memos_pat_|sk-[A-Za-z0-9_-]{16}|ghp_|AKIA|xoxb-|PRIVATE KEY|hunter2|abcdef123/,
      );
    }
  });
});

describe("zcode import", () => {
  it("maps <name>-<hash16> dirs to workspace paths and parses frontmatter", () => {
    const home = tmpHome();
    const projDir = join(home, "code", "myproj");
    mkdirSync(projDir, { recursive: true });
    const zc = join(
      home,
      "zcode",
      "cli",
      "memories",
      "projects",
      `myproj-${h16(projDir)}`,
      "memory",
    );
    mkdirSync(zc, { recursive: true });
    writeFileSync(join(zc, "MEMORY.md"), "# index\n");
    writeFileSync(
      join(zc, "note-one.md"),
      `---\nname: note-one\ndescription: the first lesson\nmetadata:\n  node_type: memory\n  type: project\n  originSessionId: sess_abc\n---\n\nBody paragraph one.\n`,
    );
    // unmatched project dir → global + tag
    const zc2 = join(
      home,
      "zcode",
      "cli",
      "memories",
      "projects",
      "ghostproj-0000000000000000",
      "memory",
    );
    mkdirSync(zc2, { recursive: true });
    writeFileSync(
      join(zc2, "orphan.md"),
      `---\nname: orphan\ndescription: orphan lesson\nmetadata:\n  type: user\n---\n\nBody.\n`,
    );

    const env = { HOME: home, ZCODE_HOME: join(home, "zcode") };
    const items = collectZcodeMemories(env);
    expect(items.length).toBe(2);

    const one = items.find((i: ImportItem) => i.label.includes("note-one"));
    expect(one.args.content).toBe("the first lesson");
    expect(one.args.scope_type).toBe("project");
    expect(one.args.scope_key).toBe(projDir);
    expect(one.args.source_session).toBe("sess_abc");
    expect(one.args.tags).toEqual(["imported", "zcode", "project"]);
    expect(one.args.idempotency_key).toMatch(/^import:zcode:[0-9a-f]{40}$/);
    expect(one.args.evidence[0].source_id).toContain("zcode:");
    expect(one.args.evidence[0].excerpt).toContain("Body paragraph one.");

    const orphan = items.find((i: ImportItem) => i.label.includes("orphan"));
    expect(orphan.args.scope_type).toBe("global");
    expect(orphan.args.tags).toContain("zcode-project:ghostproj");
  });

  it("falls back to the first paragraph when description is missing", () => {
    const fm = parseZcodeFrontmatter(
      "---\nname: x\nmetadata:\n  type: project\n---\n\nPara one here.\n\nPara two.\n",
    );
    expect(fm.description).toBe("");
    expect(fm.type).toBe("project");
    expect(fm.body).toContain("Para one here.");
  });
});

describe("codex import", () => {
  it("splits memory_summary globals and MEMORY.md task-group bullets", () => {
    const home = tmpHome();
    const projDir = join(home, "code", "projA");
    mkdirSync(projDir, { recursive: true });
    const memDir = join(home, "codex", "memories");
    mkdirSync(memDir, { recursive: true });
    writeFileSync(
      join(memDir, "memory_summary.md"),
      `v1\n\n## User Profile\n\nUser works in Chinese.\n\n## User preferences\n\n- Pref A\n- Pref B\n\n## General Tips\n\n- Tip one\n\n## What's in Memory\n\n### /x\n`,
    );
    writeFileSync(
      join(memDir, "MEMORY.md"),
      `# Task Group: ${projDir} / title words\n\nscope: x\n\n## Task 1: something\n\n### keywords\n\n- skip me\n\n## User preferences\n\n- Group pref\n\n## Reusable knowledge\n\n- Reusable fact\n\n## Failures and how to do differently\n\n- Failure lesson\n`,
    );
    writeFileSync(join(memDir, "raw_memories.md"), "- ignored\n");

    const env = { HOME: home, CODEX_HOME: join(home, "codex") };
    const items = collectCodexMemories(env);
    // 1 profile + 2 prefs + 1 tip = 4 global; 3 project bullets
    expect(items.length).toBe(7);
    const globals = items.filter(
      (i: ImportItem) => i.args.scope_type === "global",
    );
    const projects = items.filter(
      (i: ImportItem) => i.args.scope_type === "project",
    );
    expect(globals.length).toBe(4);
    expect(projects.length).toBe(3);
    expect(projects[0].args.scope_key).toBe(projDir);
    expect(projects.map((p: ImportItem) => p.args.tags[2]).sort()).toEqual([
      "failures-and-how-to-do-differently",
      "reusable-knowledge",
      "user-preferences",
    ]);
    expect(
      items.every((i: ImportItem) =>
        i.args.idempotency_key.startsWith("import:codex:"),
      ),
    ).toBe(true);
    // Task-section bullets never imported
    expect(
      items.every((i: ImportItem) => !i.args.content.includes("skip me")),
    ).toBe(true);
  });
});

describe("pi import", () => {
  it("splits §-separated entries and maps projects-memory dirs to ~/code paths", async () => {
    const { collectPiMemories } = await import(
      // @ts-expect-error plain-JS modules without types
      "../../harness/core/importer.mjs"
    );
    const home = tmpHome();
    const projDir = join(home, "code", "projA");
    mkdirSync(projDir, { recursive: true });
    const pi = join(home, "pi", "agent");
    writeFile(
      join(pi, "pi-hermes-memory", "MEMORY.md"),
      `fact one <!-- created=2026-09-01, last=2026-09-03 -->\n§\nsecret token=hunter2 fact\n§\n`,
    );
    writeFile(
      join(pi, "pi-hermes-memory", "failures.md"),
      `[failure] lesson learned\n`,
    );
    writeFile(
      join(pi, "pi-hermes-memory", ".MEMORY.md.retired-1"),
      `retired must not import\n`,
    );
    writeFile(
      join(pi, "projects-memory", "projA", "MEMORY.md"),
      `proj fact\n§\nanother proj fact\n`,
    );
    writeFile(
      join(pi, "projects-memory", "gone-proj", "MEMORY.md"),
      `orphan fact\n`,
    );

    const env = { HOME: home, PI_HOME: pi };
    const items = collectPiMemories(env) as ImportItem[];
    // 2 MEMORY + 1 failures global; projA → project; gone-proj → global
    expect(items.length).toBe(6);
    const projects = items.filter((i) => i.args.scope_type === "project");
    expect(projects.length).toBe(2);
    expect(projects[0].args.scope_key).toBe(projDir);
    const orphan = items.find((i) => i.args.content.includes("orphan fact"));
    expect(orphan?.args.scope_type).toBe("global");
    expect(orphan?.args.tags).toContain("pi-project:gone-proj");
    const secret = items.find((i) =>
      i.args.content.includes("[REDACTED_SECRET]"),
    );
    expect(secret).toBeTruthy();
    expect(
      items.every((i) => i.args.content.includes("retired") === false),
    ).toBe(true);
    expect(
      items.every((i) => i.args.idempotency_key.startsWith("import:pi:")),
    ).toBe(true);
  });
});
