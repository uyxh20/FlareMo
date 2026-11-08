import { describe, expect, it } from "vitest";
import {
  forkReadLink,
  htmlToText,
  LINK_TEXT_MAX_CHARS,
  pickTrack,
  playerFromHtml,
  readHtmlPage,
  transcriptFromJson3,
  youtubeVideoId,
} from "./link-read";

// The link reader behind the agent's read_link (fork-owned,
// docs/fork-link-summaries.md). Stubbed fetches only: no network.

type Route = (url: string, init?: RequestInit) => Response | undefined;

function stubFetch(...routes: Route[]) {
  const seen: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push(url);
    for (const route of routes) {
      const response = route(url, init);
      if (response) return response;
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetcher, seen };
}

const html = (body: string, head = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;

const longText = "Sleep is when the brain clears out waste. ".repeat(40);

describe("the link reader", () => {
  it("keeps a page's article text, headings and lists, and drops the chrome", () => {
    const page = readHtmlPage(
      html(
        `<nav>Home | About</nav><header>Site</header>
         <article><h1>Why sleep</h1><p>${longText}</p>
         <ul><li>One</li><li>Two &amp; three</li></ul>
         <script>track()</script></article><footer>© 2026</footer>`,
        `<title>Why sleep | Blog</title><meta property="og:title" content="Why sleep">`,
      ),
      "https://example.com/why-sleep",
    );
    expect(page).toMatchObject({
      title: "Why sleep",
      read: "full",
      kind: "page",
    });
    expect(page.text).toContain("# Why sleep");
    expect(page.text).toContain("- Two & three");
    expect(page.text).not.toMatch(/Home \| About|track\(\)|© 2026/);
  });

  it("reads a thin page as partial, with its description", () => {
    const page = readHtmlPage(
      html(
        `<div id="root"></div>`,
        `<meta name="description" content="A post about sleep.">`,
      ),
      "https://x.com/someone/status/1",
    );
    expect(page.read).toBe("description");
    expect(page.text).toBe("A post about sleep.");
    expect(page.note).toContain("JavaScript");
  });

  it("decodes entities and collapses blank lines", () => {
    expect(
      htmlToText("<p>a&nbsp;b &#8212; c&#x2019;s</p><p></p><p></p><p>d</p>"),
    ).toBe("a b — c’s\n\nd");
  });

  it("fetches a page through checked redirects", async () => {
    const { fetcher, seen } = stubFetch(
      (url) =>
        url === "https://short.link/a"
          ? new Response(null, {
              status: 301,
              headers: { location: "https://example.com/why-sleep" },
            })
          : undefined,
      (url) =>
        url === "https://example.com/why-sleep"
          ? new Response(html(`<main><p>${longText}</p></main>`), {
              headers: { "content-type": "text/html; charset=utf-8" },
            })
          : undefined,
    );
    const page = await forkReadLink("https://short.link/a", { fetch: fetcher });
    expect(seen).toEqual([
      "https://short.link/a",
      "https://example.com/why-sleep",
    ]);
    expect(page.url).toBe("https://example.com/why-sleep");
    expect(page.read).toBe("full");
  });

  it("refuses internal addresses, also behind a redirect", async () => {
    const { fetcher } = stubFetch((url) =>
      url === "https://example.com/r"
        ? new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest" },
          })
        : undefined,
    );
    await expect(
      forkReadLink("http://127.0.0.1/admin", { fetch: fetcher }),
    ).rejects.toThrow("internal IP");
    await expect(
      forkReadLink("https://example.com/r", { fetch: fetcher }),
    ).rejects.toThrow("internal IP");
  });

  it("says when the site refuses", async () => {
    const { fetcher } = stubFetch(() => new Response("no", { status: 403 }));
    await expect(
      forkReadLink("https://example.com/paywall", { fetch: fetcher }),
    ).rejects.toThrow("the site answered 403");
  });

  it("cuts a very long page and says so", async () => {
    const { fetcher } = stubFetch(
      () =>
        new Response(html(`<main><p>${"word ".repeat(50_000)}</p></main>`), {
          headers: { "content-type": "text/html" },
        }),
    );
    const page = await forkReadLink("https://example.com/book", {
      fetch: fetcher,
    });
    expect(page.read).toBe("partial");
    expect(page.text.length).toBe(LINK_TEXT_MAX_CHARS);
    expect(page.note).toContain("very long");
  });

  it("reads a PDF through Workers AI", async () => {
    const { fetcher } = stubFetch(
      () =>
        new Response(new Uint8Array([37, 80, 68, 70]), {
          headers: { "content-type": "application/pdf" },
        }),
    );
    const names: string[] = [];
    const ai = {
      toMarkdown: async (file: { name: string }) => {
        names.push(file.name);
        return {
          id: "1",
          name: file.name,
          mimeType: "application/pdf",
          format: "markdown" as const,
          tokens: 10,
          data: `# A paper\n\n${longText}`,
        };
      },
    } as never;
    const pdf = await forkReadLink("https://arxiv.org/pdf/2401.00001", {
      fetch: fetcher,
      ai,
    });
    expect(names).toEqual(["2401.00001.pdf"]);
    expect(pdf).toMatchObject({ kind: "pdf", title: "A paper", read: "full" });
  });
});

describe("YouTube", () => {
  it("finds the video id in every link shape", () => {
    for (const link of [
      "https://www.youtube.com/watch?v=y9Sg--RDtks&t=30",
      "https://youtu.be/y9Sg--RDtks?si=abc",
      "https://m.youtube.com/watch?v=y9Sg--RDtks",
      "https://www.youtube.com/shorts/y9Sg--RDtks",
      "https://www.youtube.com/live/y9Sg--RDtks",
    ]) {
      expect(youtubeVideoId(new URL(link))).toBe("y9Sg--RDtks");
    }
    expect(
      youtubeVideoId(new URL("https://www.youtube.com/@channel")),
    ).toBeNull();
  });

  it("prefers English written captions over automatic ones", () => {
    expect(
      pickTrack([
        { languageCode: "de", baseUrl: "de" },
        { languageCode: "en", kind: "asr", baseUrl: "asr" },
        { languageCode: "en-GB", baseUrl: "en" },
      ])?.baseUrl,
    ).toBe("en");
  });

  it("turns caption events into timed paragraphs", () => {
    expect(
      transcriptFromJson3({
        events: [
          { tStartMs: 0, segs: [{ utf8: "Hello" }, { utf8: " there" }] },
          { tStartMs: 30_000, segs: [{ utf8: "\n" }] },
          { tStartMs: 61_000, segs: [{ utf8: "Next minute." }] },
          { tStartMs: 3_700_000, segs: [{ utf8: "An hour in." }] },
        ],
      }),
    ).toBe(
      "[0:00] Hello there\n\n[1:01] Next minute.\n\n[1:01:40] An hour in.",
    );
  });

  it("finds the player data in a watch page, braces in strings and all", () => {
    const player = { videoDetails: { title: "A {braced} talk" } };
    expect(
      playerFromHtml(
        `<script>var ytInitialPlayerResponse = ${JSON.stringify(player)};var x = {};</script>`,
      ),
    ).toEqual(player);
  });

  const player = (tracks: unknown[]) => ({
    videoDetails: {
      title: "How to think",
      author: "Some Conference",
      lengthSeconds: "3120",
      shortDescription: "A talk about thinking.",
    },
    playabilityStatus: { status: "OK" },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks } },
  });

  it("reads the transcript when YouTube gives one", async () => {
    const { fetcher } = stubFetch(
      (url) =>
        url.startsWith("https://www.youtube.com/watch")
          ? new Response(
              `<script>var ytInitialPlayerResponse = ${JSON.stringify(player([]))};</script>`,
            )
          : undefined,
      (url, init) =>
        url.includes("/youtubei/v1/player") && init?.method === "POST"
          ? Response.json(
              player([
                {
                  languageCode: "en",
                  kind: "asr",
                  baseUrl:
                    "https://www.youtube.com/api/timedtext?v=y9Sg--RDtks&lang=en",
                },
              ]),
            )
          : undefined,
      (url) =>
        url.includes("/api/timedtext") && url.includes("fmt=json3")
          ? Response.json({
              events: [
                { tStartMs: 0, segs: [{ utf8: "Thinking is a skill." }] },
              ],
            })
          : undefined,
    );
    const video = await forkReadLink("https://youtu.be/y9Sg--RDtks", {
      fetch: fetcher,
    });
    expect(video).toMatchObject({
      kind: "video",
      title: "How to think",
      details: "Some Conference, 52 min",
      read: "full",
      url: "https://www.youtube.com/watch?v=y9Sg--RDtks",
    });
    expect(video.note).toContain("automatic captions");
    expect(video.text).toContain("Description:\nA talk about thinking.");
    expect(video.text).toContain("[0:00] Thinking is a skill.");
  });

  it("falls back to the title and description when the transcript is blocked", async () => {
    const { fetcher } = stubFetch(
      (url) =>
        url.startsWith("https://www.youtube.com/watch")
          ? new Response(
              `<script>var ytInitialPlayerResponse = ${JSON.stringify(
                player([
                  {
                    languageCode: "en",
                    baseUrl:
                      "https://www.youtube.com/api/timedtext?v=y9Sg--RDtks",
                  },
                ]),
              )};</script>`,
            )
          : undefined,
      (url) => (url.includes("/api/timedtext") ? new Response("") : undefined),
    );
    const video = await forkReadLink(
      "https://www.youtube.com/watch?v=y9Sg--RDtks",
      { fetch: fetcher },
    );
    expect(video).toMatchObject({ read: "description", title: "How to think" });
    expect(video.note).toContain("no transcript");
    expect(video.text).toBe("Description:\nA talk about thinking.");
  });

  it("refuses a caption link that points off YouTube", async () => {
    const { fetcher, seen } = stubFetch((url) =>
      url.startsWith("https://www.youtube.com/watch")
        ? new Response(
            `<script>var ytInitialPlayerResponse = ${JSON.stringify(
              player([
                { languageCode: "en", baseUrl: "https://evil.example/t" },
              ]),
            )};</script>`,
          )
        : undefined,
    );
    const video = await forkReadLink("https://youtu.be/y9Sg--RDtks", {
      fetch: fetcher,
    });
    expect(video.read).toBe("description");
    expect(seen.some((url) => url.includes("evil.example"))).toBe(false);
  });
});
