import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildVolcengineFullRequest,
  createVolcengineProvider,
} from "./volcengine";

class Socket extends EventTarget {
  readyState = 1;
  bufferedAmount = 0;
  sent: (string | ArrayBuffer)[] = [];
  accept() {}
  send(data: string | ArrayBuffer) {
    this.sent.push(data);
  }
  close = vi.fn(() => {
    this.readyState = 3;
    this.dispatchEvent(new Event("close"));
  });
  binaryEvent(bytes: Uint8Array) {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    this.dispatchEvent(new MessageEvent("message", { data: buffer }));
  }
}

function serverResponseFrame(
  payload: unknown,
  { sequence = 1, negative = false, gzipped = false } = {},
) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const flags = negative ? 0b0011 : 0b0001;
  const frame = new Uint8Array(12 + json.byteLength);
  frame[0] = (0b0001 << 4) | 0b0001;
  frame[1] = (0b1001 << 4) | flags;
  frame[2] = (0b0001 << 4) | (gzipped ? 0b0001 : 0b0000);
  const view = new DataView(frame.buffer);
  view.setInt32(4, sequence, false);
  view.setUint32(8, json.byteLength, false);
  frame.set(json, 12);
  return frame;
}

function errorFrame(code: number, message: string) {
  const body = new TextEncoder().encode(message);
  const frame = new Uint8Array(12 + body.byteLength);
  frame[0] = (0b0001 << 4) | 0b0001;
  frame[1] = (0b1111 << 4) | 0b0000;
  const view = new DataView(frame.buffer);
  view.setUint32(4, code, false);
  view.setUint32(8, body.byteLength, false);
  frame.set(body, 12);
  return frame;
}

const credentials = {
  appId: "1234567890",
  accessToken: "test-access-token",
  resourceId: "volc.bigasr.sauc.duration",
};

function setup() {
  vi.useFakeTimers();
  const socket = new Socket();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ webSocket: socket, ok: true, status: 101 }),
  );
  const abort = new AbortController();
  const sentence = vi.fn();
  const error = vi.fn();
  const connecting = createVolcengineProvider(credentials).connect(
    { sampleRate: 16000 },
    sentence,
    error,
    abort.signal,
  );
  return { socket, abort, sentence, error, connecting };
}

// The adapter resolves once the first server response arrives.
async function ready(setupResult: {
  socket: Socket;
  connecting: ReturnType<StreamingConnect>;
}) {
  // Flush the connect() microtasks first so the message listeners exist.
  await vi.advanceTimersByTimeAsync(0);
  setupResult.socket.binaryEvent(
    serverResponseFrame({ audio_info: { duration: 0 } }),
  );
  return setupResult.connecting;
}
type StreamingConnect = ReturnType<
  ReturnType<typeof createVolcengineProvider>["connect"]
>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Volcano Engine (Doubao) streaming", () => {
  it("builds the bigmodel handshake payload with audio config and corpus hints", () => {
    const request = buildVolcengineFullRequest(
      { ...credentials, boostingTable: "flaremo", correctTable: "fix" },
      "req-1",
    );
    expect(request.audio).toEqual({
      format: "pcm",
      codec: "raw",
      rate: 16000,
      bits: 16,
      channel: 1,
    });
    expect(request.request.model_name).toBe("bigmodel");
    expect(request.request.show_utterances).toBe(true);
    expect(request.request.corpus).toEqual({
      boosting_table_name: "flaremo",
      correct_table_name: "fix",
    });
    expect(
      buildVolcengineFullRequest(credentials, "req-2").request.corpus,
    ).toBeUndefined();
  });

  it("goes ready on the first server response and emits definite sentences", async () => {
    const context = setup();
    const { socket, sentence, abort, error } = context;
    const _connection = await ready(context);
    expect(error).not.toHaveBeenCalled();
    const handshake = new Uint8Array(socket.sent[0] as ArrayBuffer);
    expect((handshake[1] ?? 0) >> 4).toBe(0b0001); // full client request
    expect(((handshake[2] ?? 0) >> 4) & 0b1111).toBe(0b0001); // JSON
    expect((handshake[2] ?? 0) & 0b1111).toBe(0b0000); // no compression

    socket.binaryEvent(
      serverResponseFrame({
        audio_info: { duration: 800 },
        result: {
          text: "你好，",
          utterances: [
            { text: "你好，", definite: false, start_time: 0, end_time: 800 },
          ],
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sentence).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "你好，", final: false }),
    );
    socket.binaryEvent(
      serverResponseFrame({
        result: {
          text: "你好，世界。",
          utterances: [
            {
              text: "你好，世界。",
              definite: true,
              start_time: 0,
              end_time: 1200,
            },
          ],
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sentence).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "你好，世界。", final: true }),
    );
    abort.abort();
  });

  it("drains the last negative-sequence response before finish resolves", async () => {
    const context = setup();
    const { socket } = context;
    const connection = await ready(context);
    const finished = connection.finish();
    const lastPacket = new Uint8Array(socket.sent.at(-1) as ArrayBuffer);
    expect((lastPacket[1] ?? 0) >> 4).toBe(0b0010); // audio only
    expect((lastPacket[1] ?? 0) & 0b1111).toBe(0b0010); // last packet flag
    expect(
      new DataView((socket.sent.at(-1) as ArrayBuffer).slice(4)).getUint32(
        0,
        false,
      ),
    ).toBe(0);
    socket.binaryEvent(
      serverResponseFrame(
        { result: { text: "", utterances: [] } },
        { sequence: -3, negative: true },
      ),
    );
    await expect(finished).resolves.toBeUndefined();
  });

  it("maps server error frames to failure reasons", async () => {
    const context = setup();
    const { socket, error } = context;
    const connection = await ready(context);
    socket.binaryEvent(errorFrame(55000031, "server busy"));
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "capacity" }),
    );
    await expect(connection.finish()).rejects.toThrow("ASR is not ready");
  });

  it("ignores the silence code 1013 instead of failing the session", async () => {
    const context = setup();
    const { socket, sentence, error } = context;
    const _connection = await ready(context);
    socket.binaryEvent(
      serverResponseFrame({ code: 1013, message: "no valid speech" }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(error).not.toHaveBeenCalled();
    socket.binaryEvent(
      serverResponseFrame({
        result: { utterances: [{ text: "好", definite: true }] },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(sentence).toHaveBeenCalled();
  });
});
