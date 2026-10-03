import assert from "node:assert/strict";
import test from "node:test";
import {
  failJobWhenSecretsMissing,
  missingDeployMessage,
  missingDeploySecrets,
} from "./check-cloudflare-deploy-env.mjs";

test("reports both empty Cloudflare secrets", () => {
  assert.deepEqual(missingDeploySecrets({}), [
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ACCOUNT_ID",
  ]);
  assert.deepEqual(
    missingDeploySecrets({
      CLOUDFLARE_API_TOKEN: "  ",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    }),
    ["CLOUDFLARE_API_TOKEN"],
  );
  assert.deepEqual(
    missingDeploySecrets({
      CLOUDFLARE_API_TOKEN: "token",
      CLOUDFLARE_ACCOUNT_ID: "acct",
    }),
    [],
  );
});

test("fails only an explicit workflow_dispatch when secrets are missing", () => {
  assert.equal(failJobWhenSecretsMissing("workflow_dispatch"), true);
  assert.equal(failJobWhenSecretsMissing("push"), false);
  assert.equal(failJobWhenSecretsMissing(""), false);
});

test("names the dashboard step and forbids mail keys in GitHub secrets", () => {
  const text = missingDeployMessage({
    missing: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
    eventName: "push",
  });
  assert.match(text, /CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID/);
  assert.match(text, /Settings → Builds → Connect/);
  assert.match(text, /pnpm deploy:ci/);
  assert.match(text, /Do not put RESEND_API_KEY/);
  assert.match(text, /wrangler GitHub OIDC is not available/);
  assert.doesNotMatch(text, /workflow_dispatch asked this job to publish/);
});
