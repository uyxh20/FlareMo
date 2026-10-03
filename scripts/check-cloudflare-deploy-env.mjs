#!/usr/bin/env node

// Honest credential gate for .github/workflows/deploy-cloudflare.yml.
// wrangler-action has no GitHub OIDC (cloudflare/wrangler-action#402 / #435).
// An empty CLOUDFLARE_API_TOKEN must not look like a one-second mystery crash.

import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_NAMES = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"];

export function missingDeploySecrets(env = process.env) {
  return SECRET_NAMES.filter((name) => !String(env[name] ?? "").trim());
}

export function failJobWhenSecretsMissing(eventName) {
  return eventName === "workflow_dispatch";
}

export function missingDeployMessage({ missing, eventName }) {
  const names = missing.join(" and ");
  const dispatch = eventName === "workflow_dispatch";
  return [
    `GitHub Actions deploy cannot publish: missing ${names}.`,
    "",
    "This is not a build or Worker error. The only Actions deploy attempt on",
    "uyxh20/FlareMo (run 36638224841) died here because both secrets were empty.",
    "",
    "Preferred path — no long-lived token in GitHub secrets:",
    "  1. Cloudflare Dashboard → Workers & Pages → Worker `flaremo`",
    "     (https://flaremo.ulysse-ha-19.workers.dev)",
    "  2. Settings → Builds → Connect → GitHub repository uyxh20/FlareMo",
    "  3. Production branch: main",
    "  4. Build command: pnpm install --frozen-lockfile",
    "  5. Deploy command: pnpm deploy:ci",
    "  6. Leave non-production as `wrangler versions upload`. Do not use",
    "     `pnpm deploy:ci` on preview branches (it applies production D1 migrations).",
    "  7. Confirm the live D1 binding is named `flaremo` before connecting.",
    "     `pnpm deploy:ci` reuses that name; a different name would create a new D1.",
    "  Cloudflare injects the API token for Builds. Do not put RESEND_API_KEY",
    "  in GitHub Actions secrets or Builds environment variables.",
    "",
    "Optional path — GitHub Actions wrangler-action:",
    "  Settings → Secrets and variables → Actions, then set:",
    "    CLOUDFLARE_API_TOKEN   (Edit Cloudflare Workers + D1 + R2 + Queues + Vectorize)",
    "    CLOUDFLARE_ACCOUNT_ID  (dashboard home, right sidebar)",
    "  wrangler GitHub OIDC is not available on cloudflare/wrangler-action.",
    "  Do not add RESEND_API_KEY, BETTER_AUTH_SECRET, or FLAREMO_BOOTSTRAP_SECRET",
    "  to this message or to a workflow_dispatch input.",
    "",
    dispatch
      ? "workflow_dispatch asked this job to publish. Failing because the token path is not configured."
      : "Push will not fail this check. Connect Workers Builds, or set the two secrets and re-run.",
  ].join("\n");
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const eventName = process.env.GITHUB_EVENT_NAME ?? "";
  const missing = missingDeploySecrets();
  const output = process.env.GITHUB_OUTPUT;
  if (missing.length === 0) {
    if (output) {
      appendFileSync(output, "ready=true\n");
    }
    console.log("Cloudflare Actions secrets are present.");
    process.exit(0);
  }

  console.error(missingDeployMessage({ missing, eventName }));
  if (output) {
    appendFileSync(output, "ready=false\n");
  }
  process.exit(failJobWhenSecretsMissing(eventName) ? 1 : 0);
}
