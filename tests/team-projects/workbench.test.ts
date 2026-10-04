import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
// The feature's JavaScript modules are checked by apps/web/tsconfig.team-projects.json.
// @ts-expect-error JavaScript implementation checked separately.
import {
  setTeamProjectsLocale,
  tr,
} from "../../apps/web/src/features/team-projects/copy.js";
// @ts-expect-error JavaScript implementation checked separately.
import {
  activeUsers,
  currentUser,
  listTeamMemos,
  previewAttachment,
  revisions,
  uploadAttachment,
} from "../../apps/web/src/features/team-projects/flaremo.js";
// @ts-expect-error JavaScript implementation checked separately.
import {
  CATEGORIES,
  followupStatus,
  metadataText,
  PHASE_LABELS,
  parseMemo,
  replaceMetadata,
} from "../../apps/web/src/features/team-projects/model.js";
// @ts-expect-error JavaScript implementation checked separately.
import {
  filterUrl,
  readFilters,
  readRoute,
  validListUrl,
} from "../../apps/web/src/features/team-projects/navigation.js";

const featurePath = fileURLToPath(
  new URL(
    "../../apps/web/src/features/team-projects/team-projects-app.jsx",
    import.meta.url,
  ),
);
const fixture = (data: Record<string, unknown>, id = "team_project_1") => ({
  name: `memos/${id}`,
  content: metadataText(data),
  visibility: "protected",
  state: "normal",
});
const project = {
  schema: "kosx.pm/1",
  kind: "project",
  name: "A project",
  phase: "planned",
};

afterEach(() => {
  vi.unstubAllGlobals();
  setTeamProjectsLocale("zh-CN");
});

describe("team project contract", () => {
  it("only treats protected team protocol records as projects", () => {
    expect(parseMemo(fixture(project)).type).toBe("project");
    expect(parseMemo({ ...fixture(project), visibility: "private" }).type).toBe(
      "ignored",
    );
    expect(
      parseMemo({ ...fixture(project), content: "A normal FlareMo note" }).type,
    ).toBe("ignored");
    expect(parseMemo(fixture({ ...project, phase: "unknown" })).type).toBe(
      "error",
    );
  });

  it("uses the viewer calendar day for follow-ups", () => {
    const record = { data: { phase: "active", next_check_on: "2026-10-01" } };
    expect(followupStatus(record, "2026-09-30")).toBeNull();
    expect(followupStatus(record, "2026-10-01")).toBe("今天跟进");
    expect(followupStatus(record, "2026-10-02")).toBe("跟进日期已过");
  });

  it("keeps project links and filtered return URLs in the team namespace", () => {
    expect(readRoute("/team-projects", "?project=with_underscore")).toEqual({
      kind: "detail",
      id: "memos/with_underscore",
    });
    expect(
      readRoute("/team-projects", "?project=with_underscore&edit=1"),
    ).toEqual({ kind: "edit", id: "memos/with_underscore" });
    expect(
      readRoute("/team-projects", "?project=with_underscore&edit=true"),
    ).toEqual({ kind: "edit", id: "memos/with_underscore" });
    expect(
      readRoute("/team-projects", "?project=with_underscore&edit=%221%22"),
    ).toEqual({ kind: "edit", id: "memos/with_underscore" });
    expect(readFilters("?q=%22123%22&member=users%2Fabc").query).toBe("123");
    const url = filterUrl({
      view: "all",
      member: "users/abc",
      phase: "active",
      query: "demo",
      owner: "",
      group: true,
    });
    expect(validListUrl(url)).toBe(url);
    expect(validListUrl("/projects?view=all")).toBeNull();
  });

  it("accepts a no-team identity and a read-only team identity without inventing roles", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "users/solo", team: null }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "users/reader",
            role: "reader",
            team: { id: "teams/t" },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    expect((await currentUser()).team).toBeNull();
    expect((await currentUser()).role).toBe("reader");
  });

  it("reads every team page and refuses malformed pagination", async () => {
    const first = { memos: [fixture(project, "one")], next_page_token: "next" };
    const second = { memos: [fixture(project, "two")], next_page_token: "" };
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response(JSON.stringify(first)))
        .mockResolvedValueOnce(new Response(JSON.stringify(second))),
    );
    expect(
      (await listTeamMemos()).map((memo: { name: string }) => memo.name),
    ).toEqual(["memos/one", "memos/two"]);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(
              JSON.stringify({ memos: [], next_page_token: "same" }),
            ),
        ),
    );
    await expect(listTeamMemos()).rejects.toThrow(/分页标识重复/);
  });

  it("preserves source prose and unknown metadata while refusing duplicate blocks", () => {
    const old = `Source explanation\n\n${metadataText({ ...project, extension: { approved: true } })}\n\nAdditional prose`;
    const next = replaceMetadata(old, {
      ...project,
      extension: { approved: true },
      phase: "active",
    });
    expect(next).toContain("Source explanation");
    expect(next).toContain("Additional prose");
    expect(
      parseMemo({ ...fixture(project), content: next }).data.extension,
    ).toEqual({ approved: true });
    expect(
      parseMemo({
        ...fixture(project),
        content: `${old}\n${metadataText(project)}`,
      }).type,
    ).toBe("error");
  });

  it("uses current wire for users and legacy wire only for legacy revisions/upload", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            users: [{ name: "users/a", displayName: "A", state: "NORMAL" }],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ revisions: [] })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ name: "attachments/file" })),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await activeUsers()).toEqual([{ id: "users/a", name: "A" }]);
    await revisions("memos/a");
    await uploadAttachment(
      "memos/a",
      new File(["abc"], "test.txt"),
      "client-a",
    );
    expect(fetch.mock.calls[0][1].headers["x-flaremo-wire"]).toBeUndefined();
    expect(fetch.mock.calls[1][1].headers["x-flaremo-wire"]).toBe("legacy");
    expect(fetch.mock.calls[2][1].headers["x-flaremo-wire"]).toBe("legacy");
    expect(fetch.mock.calls[2][1].body.get("client_id")).toBe("client-a");
  });

  it("never fetches file bytes after the parent memo loses protected access", async () => {
    const attachment = {
      name: "attachments/file",
      state: "ready",
      preview_url: "/api/v1/attachments/file/preview",
    };
    const response = {
      memo: {
        name: "memos/a",
        content: "",
        visibility: "private",
        state: "normal",
      },
      attachments: [attachment],
    };
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetch);
    await expect(
      previewAttachment({ attachment, memoName: "memos/a" }),
    ).rejects.toThrow(/附件访问权限待验证/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("team project language fallback", () => {
  it("translates all six phases and update categories in English", () => {
    setTeamProjectsLocale("en-US");
    for (const label of [
      ...Object.values(PHASE_LABELS),
      ...Object.values(CATEGORIES),
    ]) {
      expect(tr(label)).not.toBe(label);
    }
    expect(tr("待启动")).toBe("Planned");
    setTeamProjectsLocale("ja");
    expect(tr("待启动")).toBe("Planned");
  });

  it("has English text for every static Chinese UI phrase", () => {
    const source = readFileSync(featurePath, "utf8");
    const ast = ts.createSourceFile(
      featurePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JSX,
    );
    const phrases: string[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(ast) === "tr" &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        const phrase = node.arguments[0].text.trim().replace(/\s+/g, " ");
        if (/[\u4e00-\u9fff]/.test(phrase)) phrases.push(phrase);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    setTeamProjectsLocale("en-US");
    expect(phrases.length).toBeGreaterThan(200);
    expect(phrases.filter((phrase) => tr(phrase) === phrase)).toEqual([]);
  });
});
