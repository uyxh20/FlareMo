// Fork: the root Vitest config plus the shifted-clock setup. Used by
// scripts/fork/shifted-clock/run.mjs; see that file.
import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import base from "../../../vitest.config.ts";

export default mergeConfig(base, {
  test: {
    setupFiles: [fileURLToPath(new URL("./setup.mjs", import.meta.url))],
  },
});
