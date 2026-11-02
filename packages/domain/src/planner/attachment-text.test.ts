import { plannerAttachmentReadMax } from "@flaremo/contracts";
import { describe, expect, it } from "vitest";
import {
  plannerAttachmentReadKind,
  plannerCutComment,
  plannerEmailToText,
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
    expect(kind("notes.txt", "text/plain")).toBe("text");
    expect(kind("data.json", "application/octet-stream")).toBe("text");
    expect(kind("README.md", null)).toBe("text");
    expect(kind("archive.zip", "application/zip")).toBe("other");
    expect(kind("movie.mov", null)).toBe("other");
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
    expect(plannerEmailToText(html)).toBe("Subject: Hi\n\nOne & two\n\nthree");
    expect(plannerEmailToText("Subject: Empty\n\n")).toBe(
      "Subject: Empty\n\n(no text in the message)",
    );
  });
});
