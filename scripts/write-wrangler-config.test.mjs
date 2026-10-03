import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildWranglerConfig,
  canonicalPublicUrl,
  stripEmptyOptionalVars,
} from "./write-wrangler-config.mjs";

const exampleText = readFileSync(
  new URL("../wrangler.jsonc.example", import.meta.url),
  "utf8",
);

test("rejects database ids that are not UUIDs", () => {
  assert.throws(
    () => buildWranglerConfig({ configText: exampleText, databaseId: "abc" }),
    /FLAREMO_D1_DATABASE_ID/,
  );
});

test("rejects invalid public URLs", () => {
  assert.throws(() => canonicalPublicUrl("not-a-url"), /not a valid URL/);
  assert.throws(() => canonicalPublicUrl("http://notes.example.com"), /https/);
  assert.throws(
    () => canonicalPublicUrl("https://notes.example.com/path"),
    /origin only/,
  );
});

test("fills the example with D1 id, public URL, and deploy repository", () => {
  const text = buildWranglerConfig({
    configText: exampleText,
    databaseId: "11111111-1111-1111-1111-111111111111",
    publicUrl: "https://notes.example.com/",
    repository: "octocat/flaremo",
  });
  assert.match(text, /"database_id": "11111111-1111-1111-1111-111111111111"/);
  assert.match(text, /"FLAREMO_PUBLIC_URL": "https:\/\/notes\.example\.com"/);
  assert.match(text, /"FLAREMO_DEPLOY_REPOSITORY": "octocat\/flaremo"/);
});

test("keeps the D1 placeholder when no database id is provided", () => {
  const text = buildWranglerConfig({
    configText: exampleText,
    databaseId: "",
    publicUrl: "",
    repository: "octocat/flaremo",
  });
  assert.match(text, /REPLACE_WITH_YOUR_D1_DATABASE_ID/);
  assert.match(text, /"FLAREMO_PUBLIC_URL": ""/);
});

test("fills optional transactional email vars when provided", () => {
  const text = buildWranglerConfig({
    configText: exampleText,
    databaseId: "",
    publicUrl: "",
    repository: "octocat/flaremo",
    emailProvider: "resend",
    emailFrom: "FlareMo <no-reply@example.com>",
  });
  assert.match(text, /"FLAREMO_EMAIL_PROVIDER": "resend"/);
  assert.match(text, /"FLAREMO_EMAIL_FROM": "FlareMo <no-reply@example.com>"/);
});

test("leaves email vars empty when they are not provided", () => {
  const text = buildWranglerConfig({
    configText: exampleText,
    databaseId: "",
    publicUrl: "",
    repository: "octocat/flaremo",
  });
  assert.match(text, /"FLAREMO_EMAIL_PROVIDER": ""/);
  assert.match(text, /"FLAREMO_EMAIL_FROM": ""/);
});

test("strips unspecified email vars so deploy --keep-vars can keep Worker values", () => {
  const text = stripEmptyOptionalVars(
    buildWranglerConfig({
      configText: exampleText,
      databaseId: "",
      publicUrl: "",
      repository: "octocat/flaremo",
    }),
  );
  assert.doesNotMatch(text, /"FLAREMO_EMAIL_PROVIDER"/);
  assert.doesNotMatch(text, /"FLAREMO_EMAIL_FROM"/);
  const filled = stripEmptyOptionalVars(
    buildWranglerConfig({
      configText: exampleText,
      databaseId: "",
      publicUrl: "",
      repository: "octocat/flaremo",
      emailProvider: "resend",
      emailFrom: "FlareMo <no-reply@example.com>",
    }),
  );
  assert.match(filled, /"FLAREMO_EMAIL_PROVIDER": "resend"/);
  assert.match(
    filled,
    /"FLAREMO_EMAIL_FROM": "FlareMo <no-reply@example.com>"/,
  );
});

test("rejects a template without the D1 placeholder", () => {
  assert.throws(
    () => buildWranglerConfig({ configText: '"name": "flaremo"' }),
    /missing the D1 placeholder/,
  );
});
