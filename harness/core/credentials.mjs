// Credential resolution: env FLAREMO_URL/FLAREMO_PAT override, else the
// credentials file, else the local default URL. The PAT is never printed.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { credentialsPath, DEFAULT_URL, flaremoHome } from "./paths.mjs";

export function readCredentialsFile(home) {
  try {
    const raw = readFileSync(credentialsPath(home), "utf-8");
    const data = JSON.parse(raw);
    return {
      url: typeof data.url === "string" && data.url ? data.url : undefined,
      pat: typeof data.pat === "string" && data.pat ? data.pat : undefined,
    };
  } catch {
    return {};
  }
}

export function resolveCredentials(env = process.env, home = flaremoHome(env)) {
  const file = readCredentialsFile(home);
  const url = env.FLAREMO_URL || env.FLAREMO_DEV_URL || file.url || DEFAULT_URL;
  const pat = env.FLAREMO_PAT || file.pat || "";
  const source =
    env.FLAREMO_URL || env.FLAREMO_PAT
      ? "env"
      : file.url || file.pat
        ? "file"
        : "default";
  return { url, pat, source };
}

export function writeCredentialsFile(home, { url, pat }) {
  const path = credentialsPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ url, pat }, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    chmodSync(path, 0o600);
  } catch {}
  return path;
}

export function credentialsFileExists(home) {
  return existsSync(credentialsPath(home));
}
