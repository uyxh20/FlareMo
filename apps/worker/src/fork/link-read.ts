import type { PlannerAgentLinkReading } from "@flaremo/domain/src/planner";
import { validateExternalUrl } from "../memos-link-metadata";

// Fork add-on (docs/fork-link-summaries.md): reads a link the owner gave the
// general agent, for its read_link tool. The agent's sandbox has no web; the
// Worker fetches here instead, through the same address checks as upstream's
// link previews, and hands the agent plain text: a web page's main text, a
// YouTube video's transcript (or its title and description when YouTube gives
// none), or a PDF through Workers AI's document conversion. It never throws
// for a page that loads but says little: it says how much it read instead.

const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 5;
const MAX_HTML_BYTES = 4 * 1024 * 1024;
const MAX_PDF_BYTES = 15 * 1024 * 1024;
/** About 30,000 words: a long article or a two-hour talk. */
export const LINK_TEXT_MAX_CHARS = 180_000;
/** Less main text than this and a page is read as only partly there. */
const THIN_PAGE_CHARS = 600;
const USER_AGENT =
  "Mozilla/5.0 (compatible; SchizoDiaryLinkReader/1.0; +https://github.com/uyxh20/FlareMo)";

export type LinkReadDeps = {
  fetch?: typeof fetch;
  /** Workers AI, for PDFs; without it a PDF is not read. */
  ai?: Pick<Ai, "toMarkdown">;
};

export class LinkReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkReadError";
  }
}

export async function forkReadLink(
  input: string,
  deps: LinkReadDeps = {},
): Promise<PlannerAgentLinkReading> {
  const fetcher = deps.fetch ?? globalThis.fetch;
  const start = checkedUrl(input.trim());
  const videoId = youtubeVideoId(start);
  if (videoId) return readYoutube(videoId, start.href, fetcher);

  const response = await fetchFollowing(fetcher, start, {
    accept:
      "text/html,application/xhtml+xml,application/pdf;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  });
  const finalUrl = response.url || start.href;
  if (!response.ok) {
    throw new LinkReadError(`the site answered ${response.status}`);
  }
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (
    type.includes("application/pdf") ||
    /\.pdf$/i.test(new URL(finalUrl).pathname)
  ) {
    return readPdf(response, finalUrl, deps.ai);
  }
  if (type.startsWith("text/plain") || type.includes("markdown")) {
    const text = await readText(response, MAX_HTML_BYTES);
    return capped({
      url: finalUrl,
      kind: "text",
      title: new URL(finalUrl).pathname.split("/").pop() || finalUrl,
      read: "full",
      text,
    });
  }
  if (type && !type.includes("html") && !type.includes("xml")) {
    throw new LinkReadError(`it is a ${type.split(";")[0]} file, not a page`);
  }
  const html = await readText(response, MAX_HTML_BYTES);
  return capped(readHtmlPage(html, finalUrl));
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function checkedUrl(value: string): URL {
  try {
    return validateExternalUrl(value);
  } catch (error) {
    throw new LinkReadError(
      error instanceof Error ? error.message : "not a web address",
    );
  }
}

/** Fetches with redirects followed by hand, so every hop is checked. */
async function fetchFollowing(
  fetcher: typeof fetch,
  start: URL,
  headers: Record<string, string>,
  init: RequestInit = {},
): Promise<Response> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetchOnce(fetcher, url, headers, init);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new LinkReadError("the site redirected nowhere");
      url = checkedUrl(new URL(location, url).href);
      continue;
    }
    // A stub or a runtime that leaves url empty: say where it was read.
    if (!response.url) {
      Object.defineProperty(response, "url", { value: url.href });
    }
    return response;
  }
  throw new LinkReadError("too many redirects");
}

async function fetchOnce(
  fetcher: typeof fetch,
  url: URL,
  headers: Record<string, string>,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetcher(url.href, {
      ...init,
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        "accept-language": "en;q=1, *;q=0.5",
        ...headers,
      },
      signal: controller.signal,
    });
  } catch {
    throw new LinkReadError("the site could not be reached");
  } finally {
    clearTimeout(timeout);
  }
}

async function readBytes(
  response: Response,
  max: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new LinkReadError("it is too large to read");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function readText(response: Response, max: number): Promise<string> {
  return new TextDecoder().decode(await readBytes(response, max));
}

function capped(reading: PlannerAgentLinkReading): PlannerAgentLinkReading {
  if (reading.text.length <= LINK_TEXT_MAX_CHARS) return reading;
  return {
    ...reading,
    read: "partial",
    note: [
      reading.note,
      `it is very long, so only the first ${Math.round(LINK_TEXT_MAX_CHARS / 1000)}k characters were read`,
    ]
      .filter(Boolean)
      .join("; "),
    text: reading.text.slice(0, LINK_TEXT_MAX_CHARS),
  };
}

// ---------------------------------------------------------------------------
// Web pages
// ---------------------------------------------------------------------------

/** A page's title, description and main text, as plain text with headings. */
export function readHtmlPage(
  html: string,
  url: string,
): PlannerAgentLinkReading {
  const title =
    metaContent(html, "og:title") ||
    decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const description =
    metaContent(html, "og:description") || metaContent(html, "description");
  const text = htmlToText(mainPart(html));
  if (text.length >= THIN_PAGE_CHARS) {
    return { url, kind: "page", title, read: "full", text };
  }
  const blurb = [description, text].filter(Boolean).join("\n\n").trim();
  return {
    url,
    kind: "page",
    title,
    read: text.length > 0 ? "partial" : "description",
    note: "the page showed little text (it may need a login, or build itself with JavaScript)",
    text: blurb,
  };
}

function metaContent(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = new RegExp(
      `\\b(?:property|name)\\s*=\\s*["']${escaped}["']`,
      "i",
    );
    if (!key.test(tag)) continue;
    const content = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const value = content?.[1] ?? content?.[2];
    if (value) return decodeEntities(value).replace(/\s+/g, " ").trim();
  }
  return "";
}

/** The article, else the main part, else the body: where a page's text is. */
function mainPart(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(
      /<(script|style|noscript|svg|template|iframe|canvas|form|select|button)\b[\s\S]*?<\/\1\s*>/gi,
      " ",
    );
  const article = largest(cleaned, "article");
  if (article && article.length > 2_000) return article;
  const main = largest(cleaned, "main");
  if (main) return main;
  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(cleaned)?.[1];
  return stripChrome(body ?? cleaned);
}

function largest(html: string, tag: string): string | null {
  const pattern = new RegExp(
    `<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`,
    "gi",
  );
  let best: string | null = null;
  for (const match of html.matchAll(pattern)) {
    const inner = match[1] ?? "";
    if (!best || inner.length > best.length) best = inner;
  }
  return best ? stripChrome(best) : null;
}

/** Menus, headers, footers and side bars: not the page's text. */
function stripChrome(html: string): string {
  return html.replace(/<(nav|header|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, " ");
}

/** Block structure kept as lines: headings marked, list items dashed. */
export function htmlToText(html: string): string {
  const text = html
    .replace(
      /<h([1-6])\b[^>]*>/gi,
      (_, level: string) => `\n\n${"#".repeat(Number(level))} `,
    )
    .replace(/<\/h[1-6]\s*>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(
      /<\/?(p|div|section|article|main|blockquote|pre|ul|ol|table|tr|figure|figcaption|dl|dt|dd)\b[^>]*>/gi,
      "\n",
    )
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text)
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
  copy: "©",
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (whole, code: string) => {
      if (code[0] === "#") {
        const n =
          code[1]?.toLowerCase() === "x"
            ? Number.parseInt(code.slice(2), 16)
            : Number.parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000
          ? String.fromCodePoint(n)
          : whole;
      }
      return NAMED[code.toLowerCase()] ?? whole;
    },
  );
}

// ---------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------

async function readPdf(
  response: Response,
  url: string,
  ai: LinkReadDeps["ai"],
): Promise<PlannerAgentLinkReading> {
  const name = decodeURIComponent(
    new URL(url).pathname.split("/").pop() || "document.pdf",
  );
  if (!ai) {
    throw new LinkReadError("PDFs cannot be read here");
  }
  const bytes = await readBytes(response, MAX_PDF_BYTES);
  const result = await ai.toMarkdown({
    name: name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`,
    blob: new Blob([bytes], { type: "application/pdf" }),
  });
  if (result.format !== "markdown") {
    throw new LinkReadError("the PDF could not be converted to text");
  }
  const text = result.data.trim();
  const title =
    /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || name.replace(/\.pdf$/i, "");
  return capped(
    text.length >= THIN_PAGE_CHARS
      ? { url, kind: "pdf", title, read: "full", text }
      : {
          url,
          kind: "pdf",
          title,
          read: text ? "partial" : "description",
          note: "the PDF held little text (it may be scanned images)",
          text,
        },
  );
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/** The video id of a YouTube watch, short, live, embed or youtu.be link. */
export function youtubeVideoId(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] ?? null;
  } else if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const match = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(url.pathname);
      id = match?.[1] ?? null;
    }
  }
  return id && /^[\w-]{6,20}$/.test(id) ? id : null;
}

type CaptionTrack = {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
};

type PlayerResponse = {
  videoDetails?: {
    title?: string;
    author?: string;
    lengthSeconds?: string;
    shortDescription?: string;
  };
  captions?: {
    playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] };
  };
  playabilityStatus?: { status?: string; reason?: string };
};

// YouTube's own Android app client: its caption links work without the
// browser-only proof token the watch page's links now often need.
const INNERTUBE_URL =
  "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const INNERTUBE_CLIENT = {
  clientName: "ANDROID",
  clientVersion: "20.10.38",
  androidSdkVersion: 30,
  hl: "en",
  gl: "US",
};

async function readYoutube(
  videoId: string,
  given: string,
  fetcher: typeof fetch,
): Promise<PlannerAgentLinkReading> {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const page = await watchPage(videoId, fetcher);
  const player = await innertubePlayer(videoId, fetcher);
  const details = page?.videoDetails ?? player?.videoDetails ?? {};
  if (!details.title && !page && !player) {
    throw new LinkReadError("YouTube could not be reached");
  }
  const title = details.title?.trim() || "YouTube video";
  const minutes = Number(details.lengthSeconds) / 60;
  const about = [
    details.author?.trim(),
    Number.isFinite(minutes) && minutes > 0
      ? `${Math.max(1, Math.round(minutes))} min`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
  const description = details.shortDescription?.trim() ?? "";

  for (const tracks of [tracksOf(player), tracksOf(page)]) {
    const track = pickTrack(tracks);
    if (!track?.baseUrl) continue;
    const transcript = await fetchTranscript(track.baseUrl, fetcher);
    if (transcript) {
      return capped({
        url: watchUrl,
        kind: "video",
        title,
        details: about || undefined,
        read: "full",
        note:
          track.kind === "asr"
            ? "the transcript is YouTube's automatic captions, so names and terms may be misheard"
            : undefined,
        text: [
          description ? `Description:\n${description}` : "",
          `Transcript:\n${transcript}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      });
    }
  }
  const status = page?.playabilityStatus ?? player?.playabilityStatus;
  return {
    url: given.includes(videoId) ? watchUrl : given,
    kind: "video",
    title,
    details: about || undefined,
    read: "description",
    note:
      status?.status && status.status !== "OK"
        ? `YouTube gave no transcript (${status.reason ?? status.status})`
        : "YouTube gave no transcript for this video",
    text: description ? `Description:\n${description}` : "",
  };
}

async function watchPage(
  videoId: string,
  fetcher: typeof fetch,
): Promise<PlayerResponse | null> {
  try {
    const response = await fetchFollowing(
      fetcher,
      new URL(`https://www.youtube.com/watch?v=${videoId}&hl=en`),
      {
        accept: "text/html",
        // Skips the EU cookie wall, which has no player data.
        cookie: "CONSENT=YES+1; SOCS=CAI",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      },
    );
    if (!response.ok) return null;
    const html = await readText(response, MAX_HTML_BYTES);
    return playerFromHtml(html);
  } catch {
    return null;
  }
}

/** The ytInitialPlayerResponse object a watch page carries. */
export function playerFromHtml(html: string): PlayerResponse | null {
  const marker = html.indexOf("ytInitialPlayerResponse");
  if (marker < 0) return null;
  const start = html.indexOf("{", marker);
  if (start < 0) return null;
  const json = balancedObject(html, start);
  if (!json) return null;
  try {
    return JSON.parse(json) as PlayerResponse;
  } catch {
    return null;
  }
}

/** The JSON object starting at `start`, braces in strings skipped. */
function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function innertubePlayer(
  videoId: string,
  fetcher: typeof fetch,
): Promise<PlayerResponse | null> {
  try {
    const response = await fetchFollowing(
      fetcher,
      new URL(INNERTUBE_URL),
      {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": `com.google.android.youtube/${INNERTUBE_CLIENT.clientVersion} (Linux; U; Android 11) gzip`,
      },
      {
        method: "POST",
        body: JSON.stringify({
          context: { client: INNERTUBE_CLIENT },
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      },
    );
    if (!response.ok) return null;
    return (await response.json()) as PlayerResponse;
  } catch {
    return null;
  }
}

function tracksOf(player: PlayerResponse | null): CaptionTrack[] {
  return player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
}

/** English written captions, else English automatic, else any written, else any. */
export function pickTrack(tracks: CaptionTrack[]): CaptionTrack | null {
  const english = (track: CaptionTrack) =>
    track.languageCode?.toLowerCase().startsWith("en") ?? false;
  return (
    tracks.find((track) => english(track) && track.kind !== "asr") ??
    tracks.find(english) ??
    tracks.find((track) => track.kind !== "asr") ??
    tracks[0] ??
    null
  );
}

async function fetchTranscript(
  baseUrl: string,
  fetcher: typeof fetch,
): Promise<string> {
  let url: URL;
  try {
    url = new URL(baseUrl, "https://www.youtube.com");
  } catch {
    return "";
  }
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return "";
  url.searchParams.set("fmt", "json3");
  try {
    const response = await fetchFollowing(fetcher, url, {
      accept: "application/json",
    });
    if (!response.ok) return "";
    const body = await readText(response, MAX_HTML_BYTES);
    if (!body.trim()) return "";
    return transcriptFromJson3(JSON.parse(body));
  } catch {
    return "";
  }
}

type Json3 = {
  events?: Array<{ tStartMs?: number; segs?: Array<{ utf8?: string }> }>;
};

/** Caption events as paragraphs of about a minute, each with its time. */
export function transcriptFromJson3(data: Json3): string {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let startedAt = -1;
  for (const event of data.events ?? []) {
    const words = (event.segs ?? [])
      .map((seg) => seg.utf8 ?? "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    if (!words) continue;
    const at = event.tStartMs ?? 0;
    if (startedAt < 0) startedAt = at;
    if (at - startedAt >= 60_000 && current.length) {
      paragraphs.push(`[${clock(startedAt)}] ${current.join(" ")}`);
      current = [];
      startedAt = at;
    }
    current.push(words);
  }
  if (current.length)
    paragraphs.push(`[${clock(startedAt)}] ${current.join(" ")}`);
  return paragraphs.join("\n\n");
}

function clock(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}
