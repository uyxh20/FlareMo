import { describe, expect, it } from "vitest";
import {
  plannerEncodeWav,
  plannerReadingCopyKind,
  plannerSplitSound,
} from "./attachment-reading-copy";

// The reading copy's pure parts (docs/fork-task-attachments.md, "Audio, video
// and iPhone photos"): which files need one, the WAV encoding Whisper takes,
// and the cut into two-minute parts. Decoding and frames need a real browser.

describe("plannerReadingCopyKind", () => {
  const kind = (name: string, type: string, size = 1000) =>
    plannerReadingCopyKind({ name, type, size });
  it("asks for a copy of audio, video, HEIC and photos too big for Claude", () => {
    expect(kind("memo.m4a", "audio/mp4")).toBe("audio");
    expect(kind("memo.m4a", "")).toBe("audio");
    expect(kind("clip.mp4", "video/mp4")).toBe("video");
    expect(kind("clip.mov", "")).toBe("video");
    expect(kind("IMG_1.HEIC", "")).toBe("photo");
    expect(kind("IMG_1.jpg", "image/jpeg", 6 * 1024 * 1024)).toBe("photo");
  });
  it("leaves files Claude or the Worker read as they are", () => {
    expect(kind("IMG_1.jpg", "image/jpeg", 2 * 1024 * 1024)).toBeNull();
    expect(kind("quote.pdf", "application/pdf")).toBeNull();
    expect(kind("notes.txt", "text/plain")).toBeNull();
  });
});

describe("plannerEncodeWav", () => {
  it("writes a 16-bit mono PCM header and clamps samples", async () => {
    const wav = plannerEncodeWav(new Float32Array([0, 1, -1, 2]), 16000);
    expect(wav.size).toBe(44 + 8);
    const view = new DataView(await wav.arrayBuffer());
    const text = (offset: number) =>
      String.fromCharCode(
        ...new Uint8Array(view.buffer.slice(offset, offset + 4)),
      );
    expect(text(0)).toBe("RIFF");
    expect(text(8)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(46, true)).toBe(0x7fff);
    expect(view.getInt16(48, true)).toBe(-0x8000);
    expect(view.getInt16(50, true)).toBe(0x7fff);
  });
});

describe("plannerSplitSound", () => {
  it("cuts two-minute parts, drops a last sliver under a second, stops at 15", () => {
    const rate = 100;
    const fiveMinutes = new Float32Array(rate * 300 + 50);
    const parts = plannerSplitSound(fiveMinutes, rate);
    expect(parts.map((part) => part.part)).toEqual([
      "audio-01.wav",
      "audio-02.wav",
      "audio-03.wav",
    ]);
    const hour = new Float32Array(rate * 3600);
    expect(plannerSplitSound(hour, rate)).toHaveLength(15);
    // A two-minute part at 16 kHz fits under the server's 4 MB.
    expect(44 + 16000 * 120 * 2).toBeLessThan(4 * 1024 * 1024);
  });
});
