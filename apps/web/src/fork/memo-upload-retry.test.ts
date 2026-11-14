import { describe, expect, it, vi } from "vitest";
import { ApiError, type Memo } from "@/api";
import {
  ForkAttachmentUploadError,
  forkIsRetryableUploadError,
  forkMemoTakesFiles,
  forkWithUploadRetry,
} from "./memo-upload-retry";

describe("note uploads that survive a hiccup", () => {
  it("retries a dropped connection, then succeeds", async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce("ok");
    await expect(forkWithUploadRetry(run, [0, 0])).resolves.toBe("ok");
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("gives up after the retries", async () => {
    const run = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(forkWithUploadRetry(run, [0, 0])).rejects.toThrow("fetch");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not retry a refusal the server meant", async () => {
    const run = vi.fn().mockRejectedValue(new ApiError("too large", 413));
    await expect(forkWithUploadRetry(run, [0, 0])).rejects.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
    expect(forkIsRetryableUploadError(new ApiError("x", 503))).toBe(true);
    expect(forkIsRetryableUploadError(new ApiError("x", 429))).toBe(true);
  });

  it("names the saved note and the files left", () => {
    const files = [new File(["a"], "a.md"), new File(["b"], "b.pdf")];
    const error = new ForkAttachmentUploadError(
      { name: "memos/1" } as Memo,
      files,
      new Error("x"),
    );
    expect(error.message).toBe(
      "Note saved, but a.md and 1 more didn't upload.",
    );
    expect(error.memo.name).toBe("memos/1");
  });

  it("never adds files to a trashed note", () => {
    expect(forkMemoTakesFiles({ state: "trashed" })).toBe(false);
    expect(forkMemoTakesFiles({ state: "normal" })).toBe(true);
  });
});
