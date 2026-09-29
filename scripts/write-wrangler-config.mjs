#!/usr/bin/env node

// Generate the deploy-time wrangler.jsonc used by the GitHub deploy workflow.
// Priority: a full WRANGLER_JSONC secret wins; otherwise wrangler.jsonc.example
// is filled in from the D1 id, public URL, and deploy repository inputs.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const D1_PLACEHOLDER = "REPLACE_WITH_YOUR_D1_DATABASE_ID";
const DATABASE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function canonicalPublicUrl(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return "";
  let origin;
  try {
    origin = new URL(trimmed);
  } catch {
    throw new Error("FLAREMO_PUBLIC_URL is not a valid URL.");
  }
  if (origin.protocol !== "https:") {
    throw new Error("FLAREMO_PUBLIC_URL must use https.");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error(
      "FLAREMO_PUBLIC_URL must be an origin only, for example https://notes.example.com.",
    );
  }
  return origin.origin;
}

export function buildWranglerConfig({
  configText,
  databaseId,
  publicUrl,
  repository,
  emailProvider,
  emailFrom,
}) {
  if (!configText.includes(D1_PLACEHOLDER)) {
    throw new Error("wrangler.jsonc.example is missing the D1 placeholder.");
  }
  if (databaseId && !DATABASE_ID_RE.test(databaseId)) {
    throw new Error(
      "Secret FLAREMO_D1_DATABASE_ID must be a UUID, or leave it empty to create D1 automatically.",
    );
  }
  let text = configText;
  if (databaseId) {
    text = text.replace(D1_PLACEHOLDER, databaseId);
  }
  const canonical = canonicalPublicUrl(publicUrl);
  if (canonical) {
    text = text.replace(
      '"FLAREMO_PUBLIC_URL": ""',
      `"FLAREMO_PUBLIC_URL": ${JSON.stringify(canonical)}`,
    );
  }
  const provider = String(emailProvider ?? "").trim();
  if (provider) {
    text = text.replace(
      '"FLAREMO_EMAIL_PROVIDER": ""',
      `"FLAREMO_EMAIL_PROVIDER": ${JSON.stringify(provider)}`,
    );
  }
  const from = String(emailFrom ?? "").trim();
  if (from) {
    text = text.replace(
      '"FLAREMO_EMAIL_FROM": ""',
      `"FLAREMO_EMAIL_FROM": ${JSON.stringify(from)}`,
    );
  }
  return text.replace(
    '"FLAREMO_DEPLOY_REPOSITORY": ""',
    `"FLAREMO_DEPLOY_REPOSITORY": ${JSON.stringify(repository)}`,
  );
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  try {
    main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "wrangler.jsonc setup failed.",
    );
    process.exit(1);
  }
}

function main() {
  const wranglerJsonc = process.env.WRANGLER_JSONC?.trim() ?? "";
  if (wranglerJsonc) {
    writeFileSync("wrangler.jsonc", `${wranglerJsonc}\n`);
    console.log("Wrote wrangler.jsonc from secret WRANGLER_JSONC.");
    return;
  }

  const databaseId = process.env.FLAREMO_D1_DATABASE_ID?.trim() ?? "";
  const publicUrl = process.env.FLAREMO_PUBLIC_URL?.trim() ?? "";
  const repository =
    process.env.FLAREMO_DEPLOY_REPOSITORY?.trim() ||
    process.env.GITHUB_REPOSITORY ||
    "";
  const emailProvider = process.env.FLAREMO_EMAIL_PROVIDER?.trim() ?? "";
  const emailFrom = process.env.FLAREMO_EMAIL_FROM?.trim() ?? "";

  const configText = readFileSync("wrangler.jsonc.example", "utf8");
  writeFileSync(
    "wrangler.jsonc",
    buildWranglerConfig({
      configText,
      databaseId,
      publicUrl,
      repository,
      emailProvider,
      emailFrom,
    }),
  );
  console.log("Wrote wrangler.jsonc from wrangler.jsonc.example.");
}
