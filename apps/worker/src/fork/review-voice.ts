// Fork add-on (docs/fork-review-voice.md): the voice of the weekly review.
// Speech to text and text to speech, all on Workers AI through the existing
// `AI` binding, so no audio leaves Cloudflare and no new account is needed.
// Claude (or whichever model runs the review) stays the brain: the page sends
// what was heard as an ordinary typed answer, and asks for the coach's reply
// to be read out. Nothing here is stored.
//
// FLAREMO_REVIEW_VOICE picks the voice:
//   natural (default)  Deepgram on Workers AI: nova-3 listens, aura-2 speaks.
//   basic              the older models: Whisper listens, MeloTTS speaks.
//   off                no Talk button.
// When the natural model refuses (for example over the free plan's daily
// allowance), the same call is retried once on the basic model.

export type ReviewVoiceMode = "natural" | "basic" | "off";

/** Longest clip one answer may be: 6 minutes of speech, even as AAC. */
export const REVIEW_VOICE_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
/** Longest text read out in one go. Aura-2 takes up to 2,000 characters. */
export const REVIEW_VOICE_MAX_TEXT_CHARS = 1_900;

export const REVIEW_VOICE_MODELS = {
  natural: { ears: "@cf/deepgram/nova-3", mouth: "@cf/deepgram/aura-2-en" },
  basic: {
    ears: "@cf/openai/whisper-large-v3-turbo",
    mouth: "@cf/myshell-ai/melotts",
  },
} as const;

/** The natural voice's speaker. Calm, clear, mid pitch. */
export const REVIEW_VOICE_SPEAKER = "luna";

export function reviewVoiceMode(env: {
  FLAREMO_REVIEW_VOICE?: string;
  AI?: unknown;
}): ReviewVoiceMode {
  if (!env.AI) return "off";
  const value = env.FLAREMO_REVIEW_VOICE?.trim().toLowerCase();
  if (value === "off" || value === "basic") return value;
  return "natural";
}

export class ReviewVoiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 413 | 502 = 502,
  ) {
    super(message);
    this.name = "ReviewVoiceError";
  }
}

type Bytes = Uint8Array<ArrayBuffer>;
type AiRunner = { run: (...args: never[]) => Promise<unknown> };
type Run = (
  model: string,
  input: unknown,
  options?: unknown,
) => Promise<unknown>;

function runner(ai: AiRunner): Run {
  return (model, input, options) =>
    (ai.run as unknown as Run).call(ai, model, input, options);
}

/** Text tidied for reading out: no markdown marks, links or long blank runs. */
export function reviewVoiceSpeakable(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[*_`~>#]+/g, "")
    .replace(/\s*\n\s*\n\s*/g, ". ")
    .replace(/\s+/g, " ")
    .replace(/\.\s*\./g, ".")
    .trim()
    .slice(0, REVIEW_VOICE_MAX_TEXT_CHARS);
}

function base64(bytes: Uint8Array): string {
  let out = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    out += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(out);
}

function fromBase64(text: string): Bytes {
  const raw = atob(text);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function readAll(stream: ReadableStream<Uint8Array>) {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Whatever shape a speech model hands back, as audio bytes. */
async function audioBytes(output: unknown): Promise<Bytes> {
  if (output instanceof Response) {
    if (!output.ok) throw new Error(`speech model answered ${output.status}`);
    return new Uint8Array(await output.arrayBuffer());
  }
  if (output instanceof Uint8Array) return new Uint8Array(output);
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (output instanceof ReadableStream) return readAll(output);
  if (typeof output === "string") return fromBase64(output);
  if (output && typeof output === "object" && "audio" in output) {
    const audio = (output as { audio: unknown }).audio;
    if (typeof audio === "string") return fromBase64(audio);
    return audioBytes(audio);
  }
  throw new Error("speech model gave no audio");
}

function transcriptOf(output: unknown): string {
  if (!output || typeof output !== "object") return "";
  const value = output as {
    text?: unknown;
    results?: {
      channels?: { alternatives?: { transcript?: string }[] }[];
    };
  };
  if (typeof value.text === "string") return value.text.trim();
  const said = value.results?.channels?.[0]?.alternatives?.[0]?.transcript;
  return typeof said === "string" ? said.trim() : "";
}

export type ReviewVoiceResult<T> = T & {
  /** The voice that answered: the natural one, or the basic fallback. */
  voice: "natural" | "basic";
};

/** What was said in a recorded clip. */
export async function reviewVoiceTranscribe(
  ai: AiRunner,
  mode: Exclude<ReviewVoiceMode, "off">,
  audio: Bytes,
  contentType: string,
  log: (message: string) => void = () => {},
): Promise<ReviewVoiceResult<{ text: string }>> {
  if (audio.byteLength === 0) throw new ReviewVoiceError("No audio.", 400);
  if (audio.byteLength > REVIEW_VOICE_MAX_AUDIO_BYTES)
    throw new ReviewVoiceError("That answer is too long to hear.", 413);
  const run = runner(ai);
  const basic = async () => ({
    voice: "basic" as const,
    text: transcriptOf(
      await run(REVIEW_VOICE_MODELS.basic.ears, {
        audio: base64(audio),
        task: "transcribe",
        language: "en",
        vad_filter: true,
      }),
    ),
  });
  if (mode === "basic") return basic();
  try {
    const output = await run(REVIEW_VOICE_MODELS.natural.ears, {
      audio: { body: new Blob([audio]).stream(), contentType },
      language: "en",
      smart_format: true,
      punctuate: true,
    });
    return { voice: "natural", text: transcriptOf(output) };
  } catch (error) {
    log(
      `review voice: natural listening failed, using basic (${describe(error)})`,
    );
    try {
      return await basic();
    } catch (fallback) {
      throw new ReviewVoiceError(
        `Could not hear that (${describe(fallback)}).`,
      );
    }
  }
}

/** The coach's words read out, as audio bytes with their type. */
export async function reviewVoiceSpeak(
  ai: AiRunner,
  mode: Exclude<ReviewVoiceMode, "off">,
  text: string,
  log: (message: string) => void = () => {},
): Promise<ReviewVoiceResult<{ audio: Bytes; contentType: string }>> {
  const said = reviewVoiceSpeakable(text);
  if (!said) throw new ReviewVoiceError("Nothing to read out.", 400);
  const run = runner(ai);
  const basic = async () => ({
    voice: "basic" as const,
    contentType: "audio/mpeg",
    audio: await audioBytes(
      await run(REVIEW_VOICE_MODELS.basic.mouth, { prompt: said, lang: "en" }),
    ),
  });
  if (mode === "basic") return basic();
  try {
    const output = await run(
      REVIEW_VOICE_MODELS.natural.mouth,
      { text: said, speaker: REVIEW_VOICE_SPEAKER, encoding: "mp3" },
      { returnRawResponse: true },
    );
    const audio = await audioBytes(output);
    if (audio.byteLength === 0) throw new Error("empty audio");
    return { voice: "natural", contentType: "audio/mpeg", audio };
  } catch (error) {
    log(`review voice: natural voice failed, using basic (${describe(error)})`);
    try {
      return await basic();
    } catch (fallback) {
      throw new ReviewVoiceError(
        `Could not read that out (${describe(fallback)}).`,
      );
    }
  }
}

function describe(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 160);
}
