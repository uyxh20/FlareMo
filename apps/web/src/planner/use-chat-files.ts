import {
  plannerAttachmentMaxBytesFor,
  plannerChatFilesPerQuestion,
} from "@flaremo/contracts";
import { useCallback, useRef, useState } from "react";
import { formatBytes } from "@/lib/utils";
import {
  plannerPutChatFileCopyRequest,
  plannerReadChatFileRequest,
  plannerUploadChatFileRequest,
} from "./api";
import { plannerMakeReadingCopy } from "./attachment-reading-copy";

// Files dropped in the Ask my diary chat (fork-owned add-on,
// docs/fork-task-attachments.md, "Files in Ask my diary"). The chat is about
// no task, so a file is not kept: the browser makes its reading copy (sound,
// frames, a photo as JPEG), uploads the file and the copy, and asks for the
// read, which answers the text and deletes the file. The text waits here,
// shown as a chip above the question box, and goes with the next question.

export type PlannerChatFile = {
  key: number;
  filename: string;
  state: "reading" | "ready" | "unreadable";
  text: string | null;
};

export function usePlannerChatFiles(copy: {
  tooLarge: (name: string, max: string) => string;
  tooMany: (max: number) => string;
}) {
  const [files, setFiles] = useState<PlannerChatFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const serial = useRef(0);
  const count = useRef(0);
  count.current = files.length;

  const update = (key: number, change: Partial<PlannerChatFile>) =>
    setFiles((list) =>
      list.map((entry) =>
        entry.key === key ? { ...entry, ...change } : entry,
      ),
    );

  const readOne = async (file: File, key: number) => {
    try {
      const parts = await plannerMakeReadingCopy(file);
      const { file: stored } = await plannerUploadChatFileRequest(file);
      for (const { part, blob } of parts ?? []) {
        await plannerPutChatFileCopyRequest(stored.id, part, blob);
      }
      const read = await plannerReadChatFileRequest(stored.id);
      update(key, {
        state: read.text ? "ready" : "unreadable",
        text: read.text,
      });
    } catch {
      update(key, { state: "unreadable", text: null });
    }
  };

  const add = (list: readonly File[]) => {
    setNotice(null);
    let room = plannerChatFilesPerQuestion - count.current;
    for (const file of list) {
      const max = plannerAttachmentMaxBytesFor({
        filename: file.name,
        contentType: file.type || null,
      });
      if (file.size > max) {
        setNotice(copy.tooLarge(file.name, formatBytes(max)));
        continue;
      }
      if (room <= 0) {
        setNotice(copy.tooMany(plannerChatFilesPerQuestion));
        break;
      }
      room -= 1;
      serial.current += 1;
      const key = serial.current;
      count.current += 1;
      setFiles((current) => [
        ...current,
        { key, filename: file.name, state: "reading", text: null },
      ]);
      void readOne(file, key);
    }
  };

  const remove = (key: number) =>
    setFiles((list) => list.filter((entry) => entry.key !== key));

  const clear = useCallback(() => {
    setFiles([]);
    setNotice(null);
  }, []);

  return {
    files,
    notice,
    add,
    remove,
    clear,
    reading: files.some((entry) => entry.state === "reading"),
    /** The read files, as the question sends them. */
    ready: files
      .filter((entry) => entry.state === "ready" && entry.text)
      .map((entry) => ({ filename: entry.filename, text: entry.text ?? "" })),
  };
}
