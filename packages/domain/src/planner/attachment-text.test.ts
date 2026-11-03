import { plannerAttachmentReadMax } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerAttachmentCommentHeading,
  plannerAttachmentNeedsSummary,
  plannerAttachmentReadKind,
  plannerCutComment,
  plannerEmailToText,
  plannerHtmlToText,
} from "./attachment-text";

// The readers that need no model (fork-owned add-on, docs/fork-task-
// attachments.md, phase 2): what kind a file is, the 5,000-character cut, and
// an email reduced to its headers and body.

describe("plannerAttachmentReadKind", () => {
  it("goes by the MIME type first and the extension second", () => {
    const kind = (filename: string, contentType: string | null) =>
      plannerAttachmentReadKind({ filename, contentType });
    expect(kind("shot.png", "image/png")).toBe("image");
    expect(kind("photo", "image/jpeg; charset=binary")).toBe("image");
    expect(kind("quote.pdf", "application/pdf")).toBe("pdf");
    expect(kind("quote.pdf", "application/octet-stream")).toBe("pdf");
    expect(kind("mail.eml", "application/octet-stream")).toBe("email");
    expect(kind("mail", "message/rfc822")).toBe("email");
    expect(kind("page.html", "text/html")).toBe("html");
    expect(kind("page.htm", "application/octet-stream")).toBe("html");
    expect(kind("notes.txt", "text/plain")).toBe("text");
    expect(kind("data.json", "application/octet-stream")).toBe("text");
    expect(kind("README.md", null)).toBe("text");
    expect(kind("archive.zip", "application/zip")).toBe("other");
    expect(kind("movie.mov", null)).toBe("other");
  });
});

describe("plannerHtmlToText", () => {
  it("keeps the title and the visible text, drops comments, styles, scripts and tags", () => {
    const page = [
      "<!doctype html>",
      "<!-- P015 update for Esther. Local file only. -->",
      '<html><head><meta charset="utf-8"><title>AI in the TO · 2 Nov 2026</title>',
      "<style>:root{--bg:oklch(0.968 0.005 140)}</style></head>",
      "<body><header><h1>Pilot snapshot</h1></header>",
      "<script>window.x = 1;</script>",
      "<p>Users <b>Emily</b>, Howard &amp; Toby</p>",
      "<ul><li>Reads: 15 files</li><li>Skills: 3</li></ul>",
      "<table><tr><th>Phase</th><th>Steps</th></tr><tr><td>1</td><td>4</td></tr></table>",
      "<svg><path d='M0 0'/></svg><p>&#8594; next&nbsp;week</p>",
      "</body></html>",
    ].join("\n");
    expect(plannerHtmlToText(page)).toBe(
      [
        "AI in the TO · 2 Nov 2026",
        "Pilot snapshot",
        "Users Emily, Howard & Toby",
        "Reads: 15 files",
        "Skills: 3",
        "Phase · Steps",
        "1 · 4",
        "→ next week",
      ].join("\n"),
    );
  });
});

describe("plannerHtmlToText repeats", () => {
  it("drops a title repeated as the page's heading", () => {
    expect(
      plannerHtmlToText(
        "<html><head><title>Packing list</title></head><body><h1>Packing list</h1><ul><li>Passport</li></ul></body></html>",
      ),
    ).toBe("Packing list\nPassport");
  });
});

describe("whole or summary", () => {
  it("keeps text up to the cap whole and summarises beyond it, and heads the comment accordingly", () => {
    expect(
      plannerAttachmentNeedsSummary("x".repeat(plannerAttachmentReadMax)),
    ).toBe(false);
    expect(
      plannerAttachmentNeedsSummary("x".repeat(plannerAttachmentReadMax + 1)),
    ).toBe(true);
    expect(plannerAttachmentCommentHeading("text", "notes.txt")).toBe(
      "Text of notes.txt",
    );
    expect(plannerAttachmentCommentHeading("summary", "snapshot.html")).toBe(
      "Summary of snapshot.html",
    );
  });
});

describe("plannerCutComment", () => {
  it("trims, squeezes blank lines and cuts at the cap with a mark", () => {
    expect(plannerCutComment("  a\r\n\r\n\r\n\r\nb  \n")).toBe("a\n\nb");
    const long = "x".repeat(plannerAttachmentReadMax + 50);
    const cut = plannerCutComment(long);
    expect(cut.length).toBeLessThanOrEqual(plannerAttachmentReadMax);
    expect(cut.endsWith("[cut: the file goes on]")).toBe(true);
    expect(
      plannerCutComment("x".repeat(plannerAttachmentReadMax)),
    ).toHaveLength(plannerAttachmentReadMax);
  });
});

describe("plannerEmailToText", () => {
  it("keeps who, when and what, then the plain text body", () => {
    const raw = [
      "From: Insurer <quotes@example.com>",
      "To: Anon <anon@example.org>",
      "Cc: broker@example.com",
      "Date: Mon, 27 Oct 2026 09:12:00 +0100",
      "Subject: =?utf-8?Q?Your_renewal_=E2=82=AC212?=",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "Hello,",
      "",
      "Your renewal is =E2=82=AC212 a year, from 1 January.",
      "Kind regards",
      "",
    ].join("\r\n");
    expect(plannerEmailToText(raw)).toBe(
      [
        "From: Insurer <quotes@example.com>",
        "To: Anon <anon@example.org>",
        "Cc: broker@example.com",
        "Date: Mon, 27 Oct 2026 09:12:00 +0100",
        "Subject: Your renewal €212",
        "",
        "Hello,",
        "",
        "Your renewal is €212 a year, from 1 January.",
        "Kind regards",
      ].join("\n"),
    );
  });

  it("takes the text part of a multipart mail over the HTML one, and names the attachments", () => {
    const raw = [
      "Subject: Appointment",
      'Content-Type: multipart/mixed; boundary="outer"',
      "",
      "--outer",
      'Content-Type: multipart/alternative; boundary="inner"',
      "",
      "--inner",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("Tuesday at 10, bring the card.").toString("base64"),
      "--inner",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Tuesday at <b>10</b>, bring the card.</p>",
      "--inner--",
      "--outer",
      'Content-Type: application/pdf; name="letter.pdf"',
      'Content-Disposition: attachment; filename="letter.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      "JVBERi0=",
      "--outer--",
      "",
    ].join("\n");
    expect(plannerEmailToText(raw)).toBe(
      [
        "Subject: Appointment",
        "",
        "Tuesday at 10, bring the card.",
        "",
        "Attached in the email: letter.pdf",
      ].join("\n"),
    );
  });

  it("strips the tags of an HTML-only mail, and says when there is no text", () => {
    const html = [
      "Subject: Hi",
      "Content-Type: text/html",
      "",
      "<html><style>p{}</style><body><p>One &amp; two</p><br><div>three</div></body></html>",
    ].join("\n");
    expect(plannerEmailToText(html)).toBe("Subject: Hi\n\nOne & two\nthree");
    expect(plannerEmailToText("Subject: Empty\n\n")).toBe(
      "Subject: Empty\n\n(no text in the message)",
    );
  });
});
