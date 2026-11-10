import { plannerCoachStreamFilter } from "@flaremo/domain/src/planner";
import { describe, expect, it, vi } from "vitest";
import {
  plannerAgentPreview,
  plannerAgentPreviewResponse,
} from "./agent-stream";

// Server-sent events as the session stream sends them, cut into arbitrary
// chunks to check the reader joins them.
function sse(events: unknown[], chunk = 7): ReadableStream<Uint8Array> {
  const text = events
    .map((event) => `event: message\ndata: ${JSON.stringify(event)}\n\n`)
    .join(": heartbeat\n\n");
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + chunk));
      at += chunk;
    },
  });
}

const start = (id: string) => ({
  type: "event_start",
  event: { type: "agent.message", id },
});
const delta = (id: string, text: string) => ({
  type: "event_delta",
  event_id: id,
  delta: { type: "content_delta", index: 0, content: { type: "text", text } },
});
const message = (id: string, text: string) => ({
  type: "agent.message",
  id,
  processed_at: "2026-11-10T00:00:00Z",
  content: [{ type: "text", text }],
});
const idle = { type: "session.status_idle", stop_reason: { type: "end_turn" } };

async function lines(stream: ReadableStream<Uint8Array>, mode = "free") {
  const out: unknown[] = [];
  for await (const line of plannerAgentPreview(stream, () =>
    plannerCoachStreamFilter(mode as "free"),
  )) {
    out.push(line);
  }
  return out;
}

const shown = (out: unknown[]) => {
  let text = "";
  for (const line of out as Array<Record<string, unknown>>) {
    if (line.r) text = "";
    if (typeof line.d === "string") text += line.d;
  }
  return text;
};

describe("plannerAgentPreview", () => {
  it("passes the reply on as it is written, then says idle", async () => {
    const out = await lines(
      sse([
        { type: "session.status_running" },
        start("sevt_1"),
        delta("sevt_1", "You moved "),
        delta("sevt_1", "two goals."),
        message("sevt_1", "You moved two goals."),
        idle,
      ]),
    );
    expect(out).toEqual([
      { r: true },
      { d: "You moved " },
      { d: "two goals." },
      { idle: true },
    ]);
  });

  it("hides the coach's control line", async () => {
    const out = await lines(
      sse([
        start("sevt_1"),
        delta("sevt_1", "Good week. @"),
        delta("sevt_1", '@{"advance":true}'),
        message("sevt_1", 'Good week. @@{"advance":true}'),
        idle,
      ]),
    );
    expect(shown(out)).toBe("Good week. ");
  });

  it("sends what the preview missed when the message lands", async () => {
    const out = await lines(
      sse([
        start("sevt_1"),
        delta("sevt_1", "Half"),
        message("sevt_1", "Half of it, then the rest."),
        idle,
      ]),
    );
    expect(shown(out)).toBe("Half of it, then the rest.");
  });

  it("shows a message with no preview whole", async () => {
    const out = await lines(sse([message("sevt_9", "All at once."), idle]));
    expect(out).toEqual([{ r: true }, { d: "All at once." }, { idle: true }]);
  });

  it("starts over for each message, so the last one is what shows", async () => {
    const out = await lines(
      sse([
        start("sevt_1"),
        delta("sevt_1", "Let me read your week."),
        message("sevt_1", "Let me read your week."),
        { type: "agent.mcp_tool_use", id: "sevt_2" },
        start("sevt_3"),
        delta("sevt_3", "Gym three times."),
        message("sevt_3", "Gym three times."),
        idle,
      ]),
    );
    expect(shown(out)).toBe("Gym three times.");
  });

  it("ignores deltas of another event and lines it cannot read", async () => {
    const bytes = new TextEncoder().encode(
      `data: not json\n\ndata: ${JSON.stringify(delta("sevt_x", "stray"))}\n\ndata: ${JSON.stringify(idle)}\n\n`,
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    expect(await lines(stream)).toEqual([{ idle: true }]);
  });

  it("ends without idle when the stream closes first", async () => {
    const out = await lines(sse([start("sevt_1"), delta("sevt_1", "Cut")]));
    expect(out).toEqual([{ r: true }, { d: "Cut" }]);
  });
});

describe("plannerAgentPreviewResponse", () => {
  it("is a 404 when the session is not the caller's", async () => {
    const response = await plannerAgentPreviewResponse(
      new Request("https://example.test/"),
      async () => null,
      () => plannerCoachStreamFilter("free"),
    );
    expect(response.status).toBe(404);
  });

  it("answers NDJSON lines", async () => {
    const response = await plannerAgentPreviewResponse(
      new Request("https://example.test/"),
      async () =>
        sse([
          start("sevt_1"),
          delta("sevt_1", "Hi"),
          message("sevt_1", "Hi"),
          idle,
        ]),
      () => plannerCoachStreamFilter("free"),
    );
    expect(response.headers.get("content-type")).toContain("ndjson");
    expect(await response.text()).toBe(
      '{"ready":true}\n{"r":true}\n{"d":"Hi"}\n{"idle":true}\n',
    );
  });

  it("logs once, with counts only, when the agent spoke but no live text came", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const whole = await plannerAgentPreviewResponse(
        new Request("https://example.test/"),
        async () => sse([message("sevt_1", "Private words."), idle]),
        () => plannerCoachStreamFilter("free"),
      );
      await whole.text();
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]?.[0])).toBe(
        '{"event":"planner_agent_stream_no_deltas","messages":1}',
      );

      warn.mockClear();
      const live = await plannerAgentPreviewResponse(
        new Request("https://example.test/"),
        async () =>
          sse([
            start("sevt_1"),
            delta("sevt_1", "Hi"),
            message("sevt_1", "Hi"),
            idle,
          ]),
        () => plannerCoachStreamFilter("free"),
      );
      await live.text();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
