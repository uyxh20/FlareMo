import {
  plannerAttachmentCopyAudioParts,
  plannerAttachmentCopyAudioSeconds,
  plannerAttachmentCopyFrames,
  plannerAttachmentMediaKind,
} from "@flaremo/contracts";

// The reading copy of a file on a task (fork-owned add-on,
// docs/fork-task-attachments.md, "Audio, video and iPhone photos"). A Worker
// cannot decode audio or video, and Claude cannot take a HEIC photo or one over
// 5 MB, so the browser makes a small copy from the file it is about to upload:
//
//   audio and video  the sound, resampled to 16 kHz mono and cut into WAV parts
//                    of two minutes (at most 15, so 30 minutes), for Whisper
//   video            up to six JPEG frames taken evenly through it, for Claude
//   photo            one JPEG, at most 2,048 px on its long side, for Claude
//
// The copy goes up beside the file (PUT …/attachments/:id/copy/:part) and the
// file itself is stored as it is. Every step is best effort: a part the browser
// cannot make is left out, and a file with no copy at all is still stored (the
// server then reads what it can, and "Read" stays on offer).

export type PlannerCopyPart = { part: string; blob: Blob };

/** Claude takes a picture up to 5 MB once base64-encoded, so about 3.75 MB of bytes. */
const CLAUDE_IMAGE_MAX_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
const CLAUDE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const PHOTO_MAX_SIDE = 2048;
const FRAME_MAX_SIDE = 1024;
const SAMPLE_RATE = 16_000;
/**
 * What decoding may hold in memory: 16 kHz float samples per channel. Past
 * this (about 2 hours of stereo) the sound is left out rather than risk the tab.
 */
const DECODE_MAX_BYTES = 450 * 1024 * 1024;
const STEP_TIMEOUT_MS = 15_000;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** What kind of copy a file needs, or null when the server reads it as it is. */
export function plannerReadingCopyKind(file: {
  name: string;
  type: string;
  size: number;
}): "audio" | "video" | "photo" | null {
  const media = plannerAttachmentMediaKind({
    filename: file.name,
    contentType: file.type || null,
  });
  if (media) return media;
  const type = file.type.toLowerCase();
  const extension = extensionOf(file.name);
  if (
    type === "image/heic" ||
    type === "image/heif" ||
    extension === "heic" ||
    extension === "heif"
  ) {
    return "photo";
  }
  if (CLAUDE_IMAGE_TYPES.has(type) && file.size > CLAUDE_IMAGE_MAX_BYTES) {
    return "photo";
  }
  return null;
}

/** The part name of the n-th (0-based) two-minute piece of sound. */
export function plannerAudioPartName(index: number): string {
  return `audio-${String(index + 1).padStart(2, "0")}.wav`;
}

/** One channel of mono samples (-1…1) as a 16-bit PCM WAV file. */
export function plannerEncodeWav(
  samples: Float32Array,
  sampleRate: number,
): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(
      44 + i * 2,
      clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff,
      true,
    );
  }
  return new Blob([buffer], { type: "audio/wav" });
}

/** Mono sound cut into WAV parts of two minutes, at most 15 of them. */
export function plannerSplitSound(
  mono: Float32Array,
  sampleRate: number,
): PlannerCopyPart[] {
  const perPart = sampleRate * plannerAttachmentCopyAudioSeconds;
  const parts: PlannerCopyPart[] = [];
  for (
    let index = 0;
    index < plannerAttachmentCopyAudioParts && index * perPart < mono.length;
    index++
  ) {
    const piece = mono.subarray(index * perPart, (index + 1) * perPart);
    // A last sliver under a second carries no words worth a model call.
    if (index > 0 && piece.length < sampleRate) break;
    parts.push({
      part: plannerAudioPartName(index),
      blob: plannerEncodeWav(piece, sampleRate),
    });
  }
  return parts;
}

/** Channels averaged into one, so Whisper hears both sides of a stereo file. */
function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      mono[i] = (mono[i] ?? 0) + (data[i] ?? 0) / buffer.numberOfChannels;
    }
  }
  return mono;
}

function withTimeout<T>(work: Promise<T>, ms = STEP_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** The sound of an audio or video file as WAV parts; [] when it has none or cannot be decoded. */
async function soundParts(
  file: File,
  durationSeconds: number | null,
): Promise<PlannerCopyPart[]> {
  const Offline =
    globalThis.OfflineAudioContext ??
    (globalThis as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Offline) return [];
  if (
    durationSeconds !== null &&
    durationSeconds * SAMPLE_RATE * 4 * 2 > DECODE_MAX_BYTES
  ) {
    return [];
  }
  try {
    // An offline context at 16 kHz decodes straight to Whisper's own rate.
    const context = new Offline(1, 1, SAMPLE_RATE);
    const decoded = await withTimeout(
      context.decodeAudioData(await file.arrayBuffer()),
      120_000,
    );
    return plannerSplitSound(toMono(decoded), decoded.sampleRate);
  } catch {
    return [];
  }
}

function canvasJpeg(
  source: CanvasImageSource,
  width: number,
  height: number,
  maxSide: number,
  quality: number,
): Promise<Blob | null> {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality),
  );
}

/** A photo as one JPEG; null when the browser cannot decode it (HEIC outside Safari). */
async function photoPart(file: File): Promise<PlannerCopyPart[]> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await withTimeout(image.decode());
    const blob = await canvasJpeg(
      image,
      image.naturalWidth,
      image.naturalHeight,
      PHOTO_MAX_SIDE,
      0.85,
    );
    return blob ? [{ part: "frame-1.jpg", blob }] : [];
  } catch {
    return [];
  } finally {
    URL.revokeObjectURL(url);
  }
}

function once(target: HTMLMediaElement, event: string): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      target.addEventListener(event, () => resolve(), { once: true });
      target.addEventListener("error", () => reject(new Error("media")), {
        once: true,
      });
    }),
  );
}

/** A media file's length in seconds, from its metadata; null when unknown. */
async function mediaDuration(
  file: File,
  element: "audio" | "video",
): Promise<{ duration: number | null; media: HTMLMediaElement; url: string }> {
  const url = URL.createObjectURL(file);
  const media = document.createElement(element);
  media.preload = "metadata";
  media.muted = true;
  if (media instanceof HTMLVideoElement) media.playsInline = true;
  media.src = url;
  try {
    await once(media, "loadedmetadata");
    const duration = Number.isFinite(media.duration) ? media.duration : null;
    return { duration, media, url };
  } catch {
    return { duration: null, media, url };
  }
}

/** Up to six frames taken evenly through a video. */
async function frameParts(
  video: HTMLVideoElement,
  duration: number | null,
): Promise<PlannerCopyPart[]> {
  if (!duration || !video.videoWidth) return [];
  const parts: PlannerCopyPart[] = [];
  for (let index = 0; index < plannerAttachmentCopyFrames; index++) {
    try {
      video.currentTime =
        (duration * (index + 0.5)) / plannerAttachmentCopyFrames;
      await once(video, "seeked");
      const blob = await canvasJpeg(
        video,
        video.videoWidth,
        video.videoHeight,
        FRAME_MAX_SIDE,
        0.8,
      );
      if (blob) parts.push({ part: `frame-${parts.length + 1}.jpg`, blob });
    } catch {
      break;
    }
  }
  return parts;
}

/**
 * Makes the reading copy of a file, or returns null when it needs none. An
 * empty list means it needed one and none could be made.
 */
export async function plannerMakeReadingCopy(
  file: File,
): Promise<PlannerCopyPart[] | null> {
  const kind = plannerReadingCopyKind(file);
  if (!kind) return null;
  try {
    if (kind === "photo") return await photoPart(file);
    const probe = await mediaDuration(file, kind);
    try {
      const frames =
        kind === "video" && probe.media instanceof HTMLVideoElement
          ? await frameParts(probe.media, probe.duration)
          : [];
      const sound = await soundParts(file, probe.duration);
      return [...sound, ...frames];
    } finally {
      probe.media.removeAttribute("src");
      probe.media.load();
      URL.revokeObjectURL(probe.url);
    }
  } catch {
    return [];
  }
}
