import { describe, expect, it, vi } from "vitest";
import {
  REVIEW_VOICE_MODELS,
  reviewVoiceMode,
  reviewVoiceSpeak,
  reviewVoiceSpeakable,
  reviewVoiceTranscribe,
} from "./review-voice";

const clip = new Uint8Array([1, 2, 3, 4]);

function fakeAi(answers: Record<string, (input: unknown) => unknown>) {
  const run = vi.fn(async (model: string, input: unknown) => {
    const answer = answers[model];
    if (!answer) throw new Error(`no model ${model}`);
    return answer(input);
  });
  return { run } as unknown as { run: typeof run } & {
    run: (...args: never[]) => Promise<unknown>;
  };
}

describe("reviewVoiceMode", () => {
  it("defaults to the natural voice and honours basic and off", () => {
    expect(reviewVoiceMode({ AI: {} })).toBe("natural");
    expect(reviewVoiceMode({ AI: {}, FLAREMO_REVIEW_VOICE: "basic" })).toBe(
      "basic",
    );
    expect(reviewVoiceMode({ AI: {}, FLAREMO_REVIEW_VOICE: " OFF " })).toBe(
      "off",
    );
    expect(reviewVoiceMode({ FLAREMO_REVIEW_VOICE: "natural" })).toBe("off");
  });
});

describe("reviewVoiceSpeakable", () => {
  it("drops markdown and links before reading out", () => {
    expect(
      reviewVoiceSpeakable(
        "## Week 45\n\n**Good** week. See [the plan](https://x.y) and https://a.b/c\n- one\n- two",
      ),
    ).toBe("Week 45. Good week. See the plan and a link one two");
  });
});

describe("reviewVoiceTranscribe", () => {
  it("uses Deepgram nova-3 for the natural voice", async () => {
    const ai = fakeAi({
      [REVIEW_VOICE_MODELS.natural.ears]: () => ({
        results: {
          channels: [{ alternatives: [{ transcript: " I trained twice. " }] }],
        },
      }),
    });
    const heard = await reviewVoiceTranscribe(
      ai,
      "natural",
      clip,
      "audio/webm",
    );
    expect(heard).toEqual({ voice: "natural", text: "I trained twice." });
  });

  it("falls back to Whisper when the natural model refuses", async () => {
    const ai = fakeAi({
      [REVIEW_VOICE_MODELS.natural.ears]: () => {
        throw new Error("4006: daily free allocation used up");
      },
      [REVIEW_VOICE_MODELS.basic.ears]: (input) => {
        expect(typeof (input as { audio: unknown }).audio).toBe("string");
        return { text: "Fallback words" };
      },
    });
    const log = vi.fn();
    const heard = await reviewVoiceTranscribe(
      ai,
      "natural",
      clip,
      "audio/webm",
      log,
    );
    expect(heard).toEqual({ voice: "basic", text: "Fallback words" });
    expect(log).toHaveBeenCalledOnce();
  });

  it("refuses an empty clip", async () => {
    await expect(
      reviewVoiceTranscribe(
        fakeAi({}),
        "natural",
        new Uint8Array(),
        "audio/webm",
      ),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("reviewVoiceSpeak", () => {
  it("reads out with aura-2 as mp3", async () => {
    const ai = fakeAi({
      [REVIEW_VOICE_MODELS.natural.mouth]: (input) => {
        expect(input).toMatchObject({ speaker: "luna", encoding: "mp3" });
        return new Response(new Uint8Array([9, 9, 9]));
      },
    });
    const spoken = await reviewVoiceSpeak(ai, "natural", "Hello **there**");
    expect(spoken.voice).toBe("natural");
    expect(Array.from(spoken.audio)).toEqual([9, 9, 9]);
  });

  it("uses MeloTTS for the basic voice", async () => {
    const ai = fakeAi({
      [REVIEW_VOICE_MODELS.basic.mouth]: () => ({ audio: btoa("abc") }),
    });
    const spoken = await reviewVoiceSpeak(ai, "basic", "Hello");
    expect(spoken.voice).toBe("basic");
    expect(new TextDecoder().decode(spoken.audio)).toBe("abc");
  });

  it("falls back to MeloTTS when aura-2 fails", async () => {
    const ai = fakeAi({
      [REVIEW_VOICE_MODELS.natural.mouth]: () =>
        new Response("no", { status: 403 }),
      [REVIEW_VOICE_MODELS.basic.mouth]: () => ({ audio: btoa("x") }),
    });
    const spoken = await reviewVoiceSpeak(ai, "natural", "Hello");
    expect(spoken.voice).toBe("basic");
  });
});
