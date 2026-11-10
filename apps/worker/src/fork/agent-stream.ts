import type { PlannerAgentPreviewLine } from "@flaremo/contracts";

// The agent's reply as it is written (fork-owned, docs/fork-general-agent.md,
// "Replies as they are written"). The page still asks the session for the
// answer every few seconds, and that answer is the one kept; this only shows
// the words while they come. The Worker opens the session's event stream with
// live previews of agent.message on, and turns it into short NDJSON lines:
//
// - `{"r":true}`: a new message starts; the page clears what it shows;
// - `{"d":"…"}`: more text of that message, with the coach's control line
//   ("@@…") held back;
// - `{"idle":true}`: the agent is done with the step; ask for the answer now.
//
// Previews are best effort (Anthropic may drop deltas, and a stream opened
// after a model request began gets none for it). The finished agent.message
// that ends each preview carries the whole text, so whatever the preview
// missed is sent then.

type StreamEvent = {
  type?: string;
  id?: string;
  event_id?: string;
  event?: { type?: string; id?: string };
  delta?: { content?: { type?: string; text?: unknown } };
  content?: Array<{ type?: string; text?: unknown }>;
};

/** Hides a control line from the text shown; one per message. */
export type PlannerPreviewFilter = { push(piece: string): string };

const textOf = (event: StreamEvent) =>
  (event.content ?? [])
    .map((block) =>
      block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .join("");

/** The stream ends the preview: the step is over one way or another. */
const ENDS = new Set([
  "session.status_idle",
  "session.status_terminated",
  "session.deleted",
  "session.error",
]);

/**
 * Turns the session's server-sent events into preview lines. Stops at the
 * first event that ends the step, or when the stream closes.
 */
export async function* plannerAgentPreview(
  body: ReadableStream<Uint8Array>,
  filter: () => PlannerPreviewFilter,
): AsyncGenerator<PlannerAgentPreviewLine> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let current: string | null = null;
  let raw = "";
  let hide = filter();

  const start = function* (id: string) {
    current = id;
    raw = "";
    hide = filter();
    yield { r: true } as const;
  };
  const add = function* (piece: string) {
    raw += piece;
    const out = hide.push(piece);
    if (out) yield { d: out } as const;
  };

  // One server-sent event's data, already joined.
  const handle = function* (
    data: string,
  ): Generator<PlannerAgentPreviewLine, boolean> {
    let event: StreamEvent;
    try {
      event = JSON.parse(data) as StreamEvent;
    } catch {
      return false;
    }
    if (event.type === "event_start" && event.event?.type === "agent.message") {
      if (event.event.id) yield* start(event.event.id);
      return false;
    }
    if (event.type === "event_delta") {
      const text = event.delta?.content?.text;
      if (event.event_id === current && typeof text === "string") {
        yield* add(text);
      }
      return false;
    }
    if (event.type === "agent.message") {
      const whole = textOf(event);
      if (event.id !== current || !whole.startsWith(raw)) {
        yield* start(event.id ?? "");
      }
      yield* add(whole.slice(raw.length));
      current = null;
      return false;
    }
    if (event.type && ENDS.has(event.type)) {
      yield { idle: true } as const;
      return true;
    }
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data && (yield* handle(data))) return;
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

const NDJSON_HEADERS = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/** A reply is never watched longer than this; the page asks after it anyway. */
const PREVIEW_MAX_MS = 15 * 60_000;

/**
 * The preview as an NDJSON response. `open` gives the session's event stream,
 * or null (404) when the session is not the caller's. A stream that fails
 * after it opened just ends; the page then waits for the answer as before.
 */
export async function plannerAgentPreviewResponse(
  request: Request,
  open: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array> | null>,
  filter: () => PlannerPreviewFilter,
): Promise<Response> {
  const abort = new AbortController();
  request.signal.addEventListener("abort", () => abort.abort(), {
    once: true,
  });
  const timer = setTimeout(() => abort.abort(), PREVIEW_MAX_MS);
  const source = await open(abort.signal);
  if (!source) {
    clearTimeout(timer);
    return Response.json({ error: { message: "Not found." } }, { status: 404 });
  }
  const lines = plannerAgentPreview(source, filter);
  const encoder = new TextEncoder();
  const stop = async () => {
    clearTimeout(timer);
    abort.abort();
    await lines.return(undefined).catch(() => undefined);
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await lines.next();
        if (next.done) {
          await stop();
          controller.close();
        } else {
          controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
        }
      } catch {
        await stop();
        controller.close();
      }
    },
    async cancel() {
      await stop();
    },
  });
  return new Response(body, { headers: NDJSON_HEADERS });
}
