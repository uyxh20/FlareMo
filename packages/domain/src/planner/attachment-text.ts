import {
  plannerAttachmentMediaKind,
  plannerAttachmentReadMax,
} from "@flaremo/contracts";

// What a file on a task is, for reading it into a comment (fork-owned add-on,
// docs/fork-task-attachments.md, phase 2), and the readers that need no model:
// plain text is taken as it is, an email is reduced to its headers and body, a
// web page to what a reader sees. Pictures and PDFs are read by Claude in the
// Worker (apps/worker/src/fork/attachment-read.ts), and so is any text longer
// than a comment should be, as a summary. Audio is transcribed by Whisper on
// Workers AI and video is read from its sound and a few still frames, both
// from a reading copy the browser makes; anything else is stored but not read.

export type PlannerAttachmentReadKind =
  | "text"
  | "email"
  | "html"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "other";

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "log",
  "yaml",
  "yml",
  "ics",
  "vcf",
]);
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  // iPhone photos: read from the JPEG reading copy the browser makes.
  "image/heic",
  "image/heif",
]);
const IMAGE_EXTENSIONS = new Set(["heic", "heif"]);

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/** How a file is read, from its MIME type first and its extension second. */
export function plannerAttachmentReadKind(input: {
  filename: string;
  contentType: string | null;
}): PlannerAttachmentReadKind {
  const type =
    (input.contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const extension = extensionOf(input.filename);
  if (type === "message/rfc822" || extension === "eml") return "email";
  if (
    type === "text/html" ||
    type === "application/xhtml+xml" ||
    extension === "html" ||
    extension === "htm"
  ) {
    return "html";
  }
  if (IMAGE_TYPES.has(type) || IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  const media = plannerAttachmentMediaKind(input);
  if (media) return media;
  if (type === "application/pdf" || extension === "pdf") return "pdf";
  if (type.startsWith("text/") || type === "application/json") return "text";
  if (TEXT_EXTENSIONS.has(extension)) return "text";
  return "other";
}

/** Whitespace trimmed and blank lines squeezed; what every reader hands on. */
export function plannerCleanText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * What a comment holds: a file's own text, a summary, a recording's words as
 * said, or a video's scenes and words.
 */
export type PlannerAttachmentReadForm =
  | "text"
  | "summary"
  | "transcript"
  | "video";

/** Whether a file's text is kept whole as the comment, or summarised first. */
export function plannerAttachmentNeedsSummary(text: string): boolean {
  return text.length > plannerAttachmentReadMax;
}

/**
 * The comment's text, cut under `max` with a mark. A safety net: a whole text
 * is under the cap by definition and a summary is asked to stay under its own.
 * The cut falls at the end of a line or a sentence, so the comment never stops
 * mid-word; only a text with neither in its last half is cut where it stands.
 */
export function plannerCutComment(
  text: string,
  max: number = plannerAttachmentReadMax,
): string {
  const cleaned = plannerCleanText(text);
  if (cleaned.length <= max) return cleaned;
  const mark = "\n\n[cut: the file goes on]";
  const room = cleaned.slice(0, max - mark.length);
  const floor = Math.floor(room.length / 2);
  let end = room.lastIndexOf("\n");
  // A sentence's end: . ! ? (or a closing quote or bracket after one) then a space.
  for (const match of room.matchAll(/[.!?…][)"'”’\]]*(?=\s)/g)) {
    const at = match.index + match[0].length;
    if (at > end) end = at;
  }
  const kept = end >= floor ? room.slice(0, end) : room;
  return `${kept.trimEnd()}${mark}`;
}

/** The comment's first line: where the text came from and what it is. */
export function plannerAttachmentCommentHeading(
  form: PlannerAttachmentReadForm,
  filename: string,
): string {
  const lead = {
    text: "Text of",
    summary: "Summary of",
    transcript: "Transcript of",
    video: "What's in",
  }[form];
  return `${lead} ${filename}`;
}

// --- HTML -------------------------------------------------------------------

/** A page as a reader sees it: no tags, styles, scripts or comments; blocks on their own lines. */
export function plannerHtmlToText(raw: string): string {
  const body = raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, (head) => {
      const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
      return title ? `${title}\n` : "";
    });
  // One line per block; blank lines carry nothing a comment needs, and a
  // line equal to the one before it (a title repeated as the heading) goes.
  return plannerCleanText(decodeEntities(stripTags(body)))
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line, at, lines) => line.length > 0 && line !== lines[at - 1]?.trim(),
    )
    .join("\n");
}

function stripTags(markup: string): string {
  return markup
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|tr|li|h[1-6]|section|article|header|footer|blockquote|pre|figure|figcaption|dd|dt)>/gi,
      "\n",
    )
    .replace(/<(td|th)[^>]*>/gi, " ")
    .replace(/<\/(td|th)>/gi, " · ")
    .replace(/<[^>]+>/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ · \n/g, "\n");
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

// --- Email ------------------------------------------------------------------

/** Decodes `=?charset?B|Q?…?=` words in a header, as mail programs write them. */
function decodeHeaderWords(value: string): string {
  return value
    .replace(
      /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
      (_match, charset: string, encoding: string, data: string) => {
        try {
          const bytes =
            encoding.toUpperCase() === "B"
              ? base64Bytes(data)
              : quotedPrintableBytes(data.replace(/_/g, " "));
          return new TextDecoder(charset.toLowerCase()).decode(bytes);
        } catch {
          return data;
        }
      },
    )
    .replace(/\?=\s+=\?/g, "?==?");
}

function base64Bytes(data: string): Uint8Array {
  const clean = data.replace(/[^A-Za-z0-9+/=]/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function quotedPrintableBytes(data: string): Uint8Array {
  const out: number[] = [];
  const text = data.replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    if (char === "=" && /^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))) {
      out.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(char.charCodeAt(0) & 0xff);
    }
  }
  return new Uint8Array(out);
}

type Part = { headers: Map<string, string>; body: string };

/** Splits a message or a part into unfolded headers and the body. */
function splitPart(raw: string): Part {
  const text = raw.replace(/\r\n?/g, "\n");
  const blank = text.indexOf("\n\n");
  const head = blank === -1 ? text : text.slice(0, blank);
  const body = blank === -1 ? "" : text.slice(blank + 2);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    headers.set(
      line.slice(0, colon).trim().toLowerCase(),
      line.slice(colon + 1).trim(),
    );
  }
  return { headers, body };
}

function param(header: string | undefined, name: string): string | null {
  if (!header) return null;
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|([^;\\s]+))`, "i").exec(
    header,
  );
  return match?.[2] ?? match?.[3] ?? null;
}

/** A part's body as text: transfer encoding undone, charset applied. */
function decodeBody(part: Part): string {
  const encoding = (
    part.headers.get("content-transfer-encoding") ?? ""
  ).toLowerCase();
  const charset = param(part.headers.get("content-type"), "charset") ?? "utf-8";
  try {
    if (encoding === "base64") {
      return new TextDecoder(charset).decode(base64Bytes(part.body));
    }
    if (encoding === "quoted-printable") {
      return new TextDecoder(charset).decode(quotedPrintableBytes(part.body));
    }
  } catch {
    // Fall through to the raw body.
  }
  return part.body;
}

/** The plain-text body of a message: the first text/plain part, else text/html with its tags stripped. */
function bodyText(part: Part, depth = 0): string | null {
  const type = (part.headers.get("content-type") ?? "text/plain")
    .split(";")[0]
    ?.trim()
    .toLowerCase();
  if (type?.startsWith("multipart/") && depth < 5) {
    const boundary = param(part.headers.get("content-type"), "boundary");
    if (!boundary) return null;
    const pieces = part.body
      .split(`--${boundary}`)
      .slice(1)
      .filter((piece) => !piece.startsWith("--"))
      .map((piece) => splitPart(piece.replace(/^\n/, "")));
    let html: string | null = null;
    for (const piece of pieces) {
      const found = bodyText(piece, depth + 1);
      if (found === null) continue;
      const pieceType = (piece.headers.get("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (pieceType === "text/html") {
        html ??= found;
        continue;
      }
      return found;
    }
    return html;
  }
  if (type === "text/html") return plannerHtmlToText(decodeBody(part));
  if (type?.startsWith("text/")) return decodeBody(part);
  return null;
}

/**
 * An email file (.eml, RFC 822) as a comment: who it is from and to, when,
 * the subject, then the body. Attachments inside the mail are left out; their
 * names are listed.
 */
export function plannerEmailToText(raw: string): string {
  const message = splitPart(raw);
  const header = (name: string) => {
    const value = message.headers.get(name);
    return value ? decodeHeaderWords(value) : null;
  };
  const lines = [
    header("from") ? `From: ${header("from")}` : null,
    header("to") ? `To: ${header("to")}` : null,
    header("cc") ? `Cc: ${header("cc")}` : null,
    header("date") ? `Date: ${header("date")}` : null,
    header("subject") ? `Subject: ${header("subject")}` : null,
  ].filter((line): line is string => line !== null);
  const body = bodyText(message)?.trim() ?? "";
  const attached = attachmentNames(message);
  return [
    ...lines,
    "",
    body || "(no text in the message)",
    ...(attached.length
      ? ["", `Attached in the email: ${attached.join(", ")}`]
      : []),
  ]
    .join("\n")
    .trim();
}

function attachmentNames(part: Part, depth = 0): string[] {
  const type = part.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/") || depth >= 5) return [];
  const boundary = param(type, "boundary");
  if (!boundary) return [];
  return part.body
    .split(`--${boundary}`)
    .slice(1)
    .filter((piece) => !piece.startsWith("--"))
    .map((piece) => splitPart(piece.replace(/^\n/, "")))
    .flatMap((piece) => {
      const name =
        param(piece.headers.get("content-disposition"), "filename") ??
        param(piece.headers.get("content-type"), "name");
      return name
        ? [decodeHeaderWords(name)]
        : attachmentNames(piece, depth + 1);
    });
}
