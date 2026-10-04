import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMinimaxProvider,
  MINIMAX_MAX_AUDIO_DURATION_MS,
  mapMinimaxSegments,
  minimaxDurationMs,
  minimaxFailure,
  normalizeMinimaxBaseUrl,
  sniffAudioMimeType,
} from "./minimax";
import { AsrProviderError } from "./types";

const credentials = { apiKey: "test-minimax-key" };

function wavBytes() {
  // 44-byte RIFF header plus a couple of samples; shape is what matters.
  const bytes = new Uint8Array(48);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x41, 0x56, 0x45], 8); // WAVE
  return bytes.buffer;
}

function _jsonResponse(payload: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(payload),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MiniMax batch adapter", () => {
  it("assembles the speech_to_text multipart payload with Bearer auth and a language hint", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ segments: [], duration: 1.5 }),
    });
    vi.stubGlobal("fetch", fetcher);
    const provider = createMinimaxProvider(credentials);
    const transcription = await provider.transcribe(wavBytes(), {
      language: "zh",
      startMs: 0,
    });
    expect(transcription).toEqual({ utterances: [], durationMs: 1500 });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.minimaxi.com/v1/speech_to_text");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-minimax-key");
    expect(headers.language).toBe("zh");
    const form = init.body as FormData;
    expect(form.get("model")).toBe("asr-1.0");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.get("timestamp_level")).toBe("sentence");
    const file = form.get("file");
    expect(file).toBeInstanceOf(Blob);
    expect(file?.type).toBe("audio/wav");
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });

  it("omits the language hint for auto recognition and sniffs ogg files", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ segments: [] }),
    });
    vi.stubGlobal("fetch", fetcher);
    const ogg = new Uint8Array(16);
    ogg.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
    await createMinimaxProvider(credentials).transcribe(ogg.buffer, {
      language: "auto",
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("language");
    const file = (init.body as FormData).get("file");
    expect(file?.type).toBe("audio/ogg");
    expect(formFilename(init.body as FormData)).toBe("audio.ogg");
  });

  it("forwards BCP-47 language hints (including subtags) as a header", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ segments: [] }),
    });
    vi.stubGlobal("fetch", fetcher);
    await createMinimaxProvider(credentials).transcribe(wavBytes(), {
      language: "zh-Hans-CN",
    });
    const [, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).language).toBe(
      "zh-Hans-CN",
    );
  });

  it("maps a provider timeout onto the transient timeout reason", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    await expect(
      createMinimaxProvider({ ...credentials, timeoutMs: 5 }).transcribe(
        wavBytes(),
        {},
      ),
    ).rejects.toMatchObject({ reason: "timeout", retryable: true });
  });

  it("maps verbose_json segments onto the millisecond timeline with the chunk offset", () => {
    const payload = {
      text: "你好 世界",
      duration: 2.5,
      n_speakers: 2,
      segments: [
        { id: 0, start: 0.0, end: 1.2, text: "你好", speaker: "S1" },
        { id: 1, start: 1.2, end: 2.3, text: "  " }, // silence, dropped
        { id: 2, start: 1.3, end: 2.05, text: "世界", speaker: "S2" },
      ],
    };
    const utterances = mapMinimaxSegments(payload, 480_000);
    expect(utterances).toEqual([
      { startMs: 480_000, endMs: 481_200, text: "你好", speaker: "S1" },
      { startMs: 481_300, endMs: 482_050, text: "世界", speaker: "S2" },
    ]);
    expect(minimaxDurationMs(payload)).toBe(2500);
  });

  it.each([
    [401, "authentication", false],
    [403, "authentication", false],
    [402, "quota", false],
    [429, "capacity", true],
    [400, "configuration", false],
    [413, "configuration", false],
    [422, "configuration", false],
    [500, "network", true],
    [503, "network", true],
    [undefined, "network", true],
  ])("maps HTTP %s to %s (retryable: %s)", (status, reason, retryable) => {
    const error = minimaxFailure(status);
    expect(error).toBeInstanceOf(AsrProviderError);
    expect(error.reason).toBe(reason);
    expect(error.retryable).toBe(retryable);
  });

  it("treats a domestic 200 body with a nonzero base_resp code as a failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            base_resp: { status_code: 1004, status_msg: "invalid" },
          }),
      }),
    );
    await expect(
      createMinimaxProvider(credentials).transcribe(wavBytes(), {}),
    ).rejects.toMatchObject({ reason: "configuration", retryable: false });
  });

  it("maps network and cancellation failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("network down")),
    );
    await expect(
      createMinimaxProvider(credentials).transcribe(wavBytes(), {}),
    ).rejects.toMatchObject({ reason: "network", retryable: true });
    const abort = new AbortController();
    abort.abort();
    await expect(
      createMinimaxProvider(credentials).transcribe(wavBytes(), {
        signal: abort.signal,
      }),
    ).rejects.toThrow("Capture cancelled");
  });

  it("rejects oversized audio, malformed responses and over-limit durations", async () => {
    await expect(
      createMinimaxProvider(credentials).transcribe(
        new ArrayBuffer(50 * 1024 * 1024 + 1),
        {},
      ),
    ).rejects.toMatchObject({ reason: "configuration" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("not json")),
      }),
    );
    await expect(
      createMinimaxProvider(credentials).transcribe(wavBytes(), {}),
    ).rejects.toMatchObject({ reason: "protocol" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ segments: [{ start: "x", end: 1 }] }),
      }),
    );
    await expect(
      createMinimaxProvider(credentials).transcribe(wavBytes(), {}),
    ).rejects.toMatchObject({ reason: "protocol" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            duration: MINIMAX_MAX_AUDIO_DURATION_MS / 1000 + 1,
            segments: [],
          }),
      }),
    );
    await expect(
      createMinimaxProvider(credentials).transcribe(wavBytes(), {}),
    ).rejects.toMatchObject({ reason: "configuration" });
  });

  it("normalizes the base URL and defaults to the domestic endpoint", () => {
    expect(normalizeMinimaxBaseUrl(undefined)).toBe("https://api.minimaxi.com");
    expect(normalizeMinimaxBaseUrl("https://api.minimax.io/")).toBe(
      "https://api.minimax.io",
    );
    expect(normalizeMinimaxBaseUrl("http://insecure.example")).toBeNull();
    expect(normalizeMinimaxBaseUrl("not a url")).toBeNull();
  });

  it("sniff container magic bytes", () => {
    const wav = new Uint8Array(16);
    wav.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45], 0);
    expect(sniffAudioMimeType(wav)).toBe("audio/wav");
    const ogg = new Uint8Array(8);
    ogg.set([0x4f, 0x67, 0x67, 0x53], 0);
    expect(sniffAudioMimeType(ogg)).toBe("audio/ogg");
    const unknown = new Uint8Array(8);
    expect(sniffAudioMimeType(unknown)).toBeUndefined();
  });
});

function formFilename(form: FormData): string | null {
  const file = form.get("file");
  if (typeof file === "string" || !(file instanceof Blob)) return null;
  // Blob here is a File when appended with a name.
  return (file as File).name ?? null;
}
