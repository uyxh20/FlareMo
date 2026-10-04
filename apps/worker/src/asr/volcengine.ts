import { z } from "zod";
import {
  type AsrConnection,
  AsrProviderError,
  type AsrSentence,
  asrHttpFailure,
  type StreamingAsrProvider,
  sendAsrAudio,
} from "./types";

// 大模型流式语音识别 (SAUC bigmodel) WebSocket protocol.
// Frames are a 4-byte big-endian header plus, per message type, sequence and
// payload-length fields. This adapter never compresses: the server mirrors
// the client's serialization/compression choice, and Workers has no
// synchronous gzip for the 100 ms audio frames.
const WS_URL = "https://openspeech.bytedance.com/api/v3/sauc/bigmodel_async";
const _RESOURCE_ID = "volc.bigasr.sauc.duration";

const MESSAGE_FULL_CLIENT_REQUEST = 0b0001;
const MESSAGE_AUDIO_ONLY_REQUEST = 0b0010;
const MESSAGE_FULL_SERVER_RESPONSE = 0b1001;
const MESSAGE_SERVER_ERROR = 0b1111;
const FLAG_WITH_SEQUENCE = 0b0001;
const FLAG_LAST_PACKET = 0b0010;
const FLAG_NEGATIVE_SEQUENCE = 0b0011;
const SERIALIZATION_JSON = 0b0001;
const COMPRESSION_GZIP = 0b0001;

type VolcengineCredentials = {
  appId: string;
  accessToken: string;
  resourceId: string;
  boostingTable?: string;
  correctTable?: string;
};

function frameHeader(messageType: number, flags: number) {
  return Uint8Array.of(
    (0b0001 << 4) | 0b0001,
    (messageType << 4) | flags,
    (SERIALIZATION_JSON << 4) | 0b0000,
    0b0000,
  );
}

function frameWithLength(
  messageType: number,
  flags: number,
  payload: Uint8Array,
) {
  const frame = new Uint8Array(8 + payload.byteLength);
  frame.set(frameHeader(messageType, flags), 0);
  new DataView(frame.buffer).setUint32(4, payload.byteLength, false);
  frame.set(payload, 8);
  return frame;
}

function lastPacketFrame() {
  // Last audio packet: audio-only type with the 0b0010 flag and empty payload.
  return frameWithLength(
    MESSAGE_AUDIO_ONLY_REQUEST,
    FLAG_LAST_PACKET,
    new Uint8Array(0),
  );
}

function httpFailure(status?: number) {
  return asrHttpFailure(status);
}

function statusFailure(code: number): AsrProviderError | null {
  switch (code) {
    case 45000001:
    case 45000002:
    case 45000151:
      return new AsrProviderError("configuration", false);
    case 45000081:
      return new AsrProviderError("network", true);
    case 55000031:
      return new AsrProviderError("capacity", true);
    case 20000000:
    case 1013:
      // 1013 means no valid speech in this window; silence is not a failure.
      return null;
    default:
      if (code >= 55000000 && code < 56000000)
        return new AsrProviderError("provider", true);
      return new AsrProviderError("protocol", false);
  }
}

const responseSchema = z.object({
  code: z.number().int().optional(),
  message: z.string().max(4_000).optional(),
  result: z
    .object({
      text: z.string().optional(),
      utterances: z
        .array(
          z.object({
            text: z.string().max(16_000),
            definite: z.boolean().optional(),
            start_time: z.number().int().nonnegative().optional(),
            end_time: z.number().int().nonnegative().optional(),
          }),
        )
        .max(512)
        .optional(),
    })
    .optional(),
  audio_info: z.object({ duration: z.number().nonnegative() }).optional(),
});

async function decodePayload(
  bytes: Uint8Array,
  gzipped: boolean,
): Promise<string> {
  if (!gzipped) return new TextDecoder().decode(bytes);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy.buffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

type ServerFrame =
  | { kind: "error"; code: number; message: string }
  | { kind: "response"; final: boolean; payload: unknown };

async function parseServerFrame(data: ArrayBuffer): Promise<ServerFrame> {
  const bytes = new Uint8Array(data);
  if (bytes.byteLength < 4) throw new AsrProviderError("protocol", false);
  const messageType = (bytes[1] ?? 0) >> 4;
  const flags = (bytes[1] ?? 0) & 0b1111;
  const gzipped = ((bytes[2] ?? 0) & 0b1111) === COMPRESSION_GZIP;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (messageType === MESSAGE_SERVER_ERROR) {
    const code = view.getUint32(4, false);
    const length = view.getUint32(8, false);
    let message = "server error";
    try {
      message = new TextDecoder().decode(bytes.subarray(12, 12 + length));
    } catch {
      /* Keep the generic message. */
    }
    return { kind: "error", code, message };
  }
  if (messageType !== MESSAGE_FULL_SERVER_RESPONSE)
    throw new AsrProviderError("protocol", false);
  let offset = 4;
  if (flags & FLAG_WITH_SEQUENCE) offset += 4;
  const length = view.getUint32(offset, false);
  offset += 4;
  if (offset + length > bytes.byteLength)
    throw new AsrProviderError("protocol", false);
  const text = await decodePayload(
    bytes.subarray(offset, offset + length),
    gzipped,
  );
  return {
    kind: "response",
    final: (flags & FLAG_NEGATIVE_SEQUENCE) === FLAG_NEGATIVE_SEQUENCE,
    payload: JSON.parse(text),
  };
}

export function buildVolcengineFullRequest(
  credentials: VolcengineCredentials,
  requestId: string,
) {
  return {
    user: { uid: "flaremo-capture" },
    audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
    request: {
      model_name: "bigmodel",
      enable_punc: true,
      enable_itn: true,
      show_utterances: true,
      result_type: "single",
      end_window_size: 200,
      reqid: requestId,
      workflow: "audio_in,resample,partition,vad,fe,decode,itn,nlu_punctuate",
      ...(credentials.boostingTable || credentials.correctTable
        ? {
            corpus: {
              ...(credentials.boostingTable
                ? { boosting_table_name: credentials.boostingTable }
                : {}),
              ...(credentials.correctTable
                ? { correct_table_name: credentials.correctTable }
                : {}),
            },
          }
        : {}),
    },
  };
}

export function createVolcengineProvider(
  credentials: VolcengineCredentials,
): StreamingAsrProvider {
  return {
    async connect(
      options,
      onSentence,
      onError,
      signal,
    ): Promise<AsrConnection> {
      if (signal.aborted) throw new Error("Capture cancelled");
      if (options.sampleRate !== 16000)
        throw new AsrProviderError("configuration", false);
      const connectId = crypto.randomUUID();
      const handshakeTimeout = new AbortController();
      const connectSignal = AbortSignal.any([signal, handshakeTimeout.signal]);
      const handshakeTimer = setTimeout(() => handshakeTimeout.abort(), 20_000);
      let upstream: Response;
      try {
        upstream = await fetch(WS_URL, {
          headers: {
            Upgrade: "websocket",
            "X-Api-App-Key": credentials.appId,
            "X-Api-Access-Key": credentials.accessToken,
            "X-Api-Resource-Id": credentials.resourceId,
            "X-Api-Request-Id": crypto.randomUUID(),
            "X-Api-Sequence": "-1",
            "X-Api-Connect-Id": connectId,
          },
          signal: connectSignal,
        });
      } catch {
        if (signal.aborted) throw new Error("Capture cancelled");
        throw new AsrProviderError(
          connectSignal.aborted ? "timeout" : "network",
          true,
        );
      } finally {
        // An upgrade fetch retains its signal in Workers. Do not let the
        // handshake timeout terminate a healthy long-running session.
        clearTimeout(handshakeTimer);
      }
      if (!upstream.webSocket) throw httpFailure(upstream.status);
      const socket = upstream.webSocket;
      return new Promise<AsrConnection>((resolve, reject) => {
        let state: "starting" | "running" | "finishing" | "closed" = "starting";
        let finishPromise: Promise<void> | undefined;
        let resolveFinish: (() => void) | undefined;
        let rejectFinish: ((error: Error) => void) | undefined;
        let timer = setTimeout(
          () => fail(new AsrProviderError("timeout", true)),
          15_000,
        );
        function cleanup() {
          clearTimeout(timer);
          signal.removeEventListener("abort", cancel);
          socket.removeEventListener("message", message);
          socket.removeEventListener("error", socketFailure);
          socket.removeEventListener("close", socketFailure);
          try {
            socket.close(1000, "Capture ended");
          } catch {
            /* Already closed. */
          }
        }
        function fail(error = new AsrProviderError("network", true)) {
          if (state === "closed") return;
          const previous = state;
          state = "closed";
          cleanup();
          if (previous === "starting") reject(error);
          else if (previous === "finishing") rejectFinish?.(error);
          else onError(error);
        }
        function socketFailure() {
          fail(new AsrProviderError("network", true));
        }
        function cancel() {
          if (state === "closed") return;
          const previous = state;
          state = "closed";
          cleanup();
          if (previous === "starting") reject(new Error("Capture cancelled"));
          if (previous === "finishing")
            rejectFinish?.(new Error("Capture cancelled"));
        }
        const connection: AsrConnection = {
          sendAudio(data) {
            if (state !== "running") throw new Error("ASR is not ready");
            // Plain 16 kHz PCM frames; no compression, matching the handshake.
            sendAsrAudio(
              socket,
              frameWithLength(
                MESSAGE_AUDIO_ONLY_REQUEST,
                0b0000,
                new Uint8Array(data),
              ).buffer,
            );
          },
          finish() {
            if (finishPromise) return finishPromise;
            if (state !== "running")
              return Promise.reject(new Error("ASR is not ready"));
            state = "finishing";
            finishPromise = new Promise<void>((done, error) => {
              resolveFinish = done;
              rejectFinish = error;
            });
            timer = setTimeout(
              () => fail(new AsrProviderError("timeout", true)),
              10_000,
            );
            try {
              socket.send(lastPacketFrame().buffer);
            } catch {
              fail();
            }
            return finishPromise;
          },
          close: cancel,
        };
        function message(event: MessageEvent) {
          if (state === "closed") return;
          void (async () => {
            try {
              if (
                typeof event.data === "string"
                  ? event.data.length > 512_000
                  : event.data.byteLength > 512_000
              )
                return fail(new AsrProviderError("protocol", false));
              const frame = await parseServerFrame(
                typeof event.data === "string"
                  ? new TextEncoder().encode(event.data).buffer
                  : (event.data as ArrayBuffer),
              );
              if (frame.kind === "error") {
                const failure = statusFailure(frame.code);
                return fail(failure ?? new AsrProviderError("protocol", false));
              }
              const payload = responseSchema.parse(frame.payload);
              if (payload.code !== undefined && payload.code !== 1000) {
                const failure = statusFailure(payload.code);
                if (failure) return fail(failure);
                return; // 1013 and friends: silence, not a failure.
              }
              if (state === "starting") {
                state = "running";
                clearTimeout(timer);
                resolve(connection);
                return;
              }
              for (const [index, utterance] of (
                payload.result?.utterances ?? []
              ).entries()) {
                if (!utterance.text.trim()) continue;
                const sentence: AsrSentence = {
                  id: `${connectId}:${index}`,
                  text: utterance.text,
                  final: utterance.definite === true,
                  startedAt: utterance.start_time,
                  endedAt: utterance.end_time,
                };
                onSentence(sentence);
              }
              if (state === "finishing" && frame.final) {
                state = "closed";
                cleanup();
                resolveFinish?.();
              }
            } catch (error) {
              fail(
                error instanceof AsrProviderError
                  ? error
                  : new AsrProviderError("protocol", false),
              );
            }
          })();
        }
        socket.addEventListener("message", message);
        socket.addEventListener("error", socketFailure);
        socket.addEventListener("close", socketFailure);
        signal.addEventListener("abort", cancel, { once: true });
        try {
          socket.accept();
          const request = buildVolcengineFullRequest(
            credentials,
            crypto.randomUUID(),
          );
          socket.send(
            frameWithLength(
              MESSAGE_FULL_CLIENT_REQUEST,
              0b0000,
              new TextEncoder().encode(JSON.stringify(request)),
            ).buffer,
          );
          if (signal.aborted) cancel();
          else if (connectSignal.aborted)
            fail(new AsrProviderError("timeout", true));
        } catch {
          fail(new AsrProviderError("network", true));
        }
      });
    },
  };
}
