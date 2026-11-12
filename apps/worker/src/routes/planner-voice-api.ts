import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { getRequestContext, type HonoBindings } from "../context";
import {
  REVIEW_VOICE_MAX_AUDIO_BYTES,
  REVIEW_VOICE_MAX_TEXT_CHARS,
  ReviewVoiceError,
  reviewVoiceMode,
  reviewVoiceSpeak,
  reviewVoiceTranscribe,
} from "../fork/review-voice";
import { jsonError } from "../http";
import { rateLimitGuard } from "../rate-limit";

// The weekly review's voice over HTTP (fork-owned add-on,
// docs/fork-review-voice.md). planner-api.ts mounts this sub-app, so it shares
// that file's lazy mount, authentication and JSON 404.
//
//   GET  /voice              { mode: "natural" | "basic" | "off" }
//   POST /voice/transcribe   body: the recorded clip (audio/*) -> { text, voice }
//   POST /voice/speak        { text } -> audio/mpeg, X-Review-Voice: natural|basic
//
// Nothing is stored: the clip and the audio only pass through.

export const plannerVoiceApi = new Hono<HonoBindings>();

const OFF = {
  error: { message: "Voice is turned off.", code: "voice_off" },
};

function voiceError(error: unknown) {
  return error instanceof ReviewVoiceError
    ? Response.json(
        { error: { message: error.message, code: "voice_failed" } },
        { status: error.status },
      )
    : null;
}

plannerVoiceApi.get("/voice", async (c) => {
  try {
    await getRequestContext(c);
    c.header("Cache-Control", "no-store");
    return c.json({ mode: reviewVoiceMode(c.env) });
  } catch (error) {
    return jsonError(c, error);
  }
});

plannerVoiceApi.post(
  "/voice/transcribe",
  bodyLimit({ maxSize: REVIEW_VOICE_MAX_AUDIO_BYTES + 1024 }),
  async (c) => {
    try {
      const { user } = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", user.id);
      if (throttled) return throttled;
      const mode = reviewVoiceMode(c.env);
      if (mode === "off") return c.json(OFF, 404);
      const contentType = (c.req.header("content-type") ?? "")
        .split(";")[0]
        ?.trim()
        .toLowerCase();
      if (!contentType?.startsWith("audio/") && contentType !== "video/webm")
        return c.json(
          { error: { message: "Send the clip as audio.", code: "bad_audio" } },
          415,
        );
      const audio = new Uint8Array(await c.req.arrayBuffer());
      const heard = await reviewVoiceTranscribe(
        c.env.AI,
        mode,
        audio,
        contentType === "video/webm" ? "audio/webm" : contentType,
        console.warn,
      );
      return c.json(heard);
    } catch (error) {
      return voiceError(error) ?? jsonError(c, error);
    }
  },
);

plannerVoiceApi.post(
  "/voice/speak",
  bodyLimit({ maxSize: 64 * 1024 }),
  async (c) => {
    try {
      const { user } = await getRequestContext(c);
      const throttled = await rateLimitGuard(c, "planner", user.id);
      if (throttled) return throttled;
      const mode = reviewVoiceMode(c.env);
      if (mode === "off") return c.json(OFF, 404);
      const body = (await c.req.json().catch(() => null)) as {
        text?: unknown;
      } | null;
      const text = typeof body?.text === "string" ? body.text : "";
      if (!text.trim() || text.length > REVIEW_VOICE_MAX_TEXT_CHARS * 8)
        return c.json(
          { error: { message: "Send the text to read.", code: "bad_text" } },
          400,
        );
      const spoken = await reviewVoiceSpeak(c.env.AI, mode, text, console.warn);
      return new Response(spoken.audio, {
        headers: {
          "Content-Type": spoken.contentType,
          "Cache-Control": "no-store",
          "X-Review-Voice": spoken.voice,
        },
      });
    } catch (error) {
      return voiceError(error) ?? jsonError(c, error);
    }
  },
);
