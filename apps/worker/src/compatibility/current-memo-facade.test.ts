import type { Miniflare } from "miniflare";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAppTestHarness } from "../test-support/app";
import { createTestRuntime, TEST_PASSWORD } from "../test-support/runtime";
import {
  bootstrapAndSignIn,
  extractCookieHeader,
} from "../test-support/sign-in";

let mf: Miniflare;
let env: Env;
let sessionCookie: string;

const { fetchCurrent } = createAppTestHarness(() => ({
  env,
  sessionCookie,
}));

describe("Current wire memo and attachment facade", () => {
  beforeEach(async () => {
    ({ runtime: mf, env } = await createTestRuntime({
      name: "flaremo-memos-compat",
      suffix: "source",
    }));
    sessionCookie = await bootstrapAndSignIn(env);
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it("serves current wire memos, attachments, relations, shares, and PATs", async () => {
    const signInResponse = await fetchCurrent(
      "http://flaremo.test/api/v1/auth/signin",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          passwordCredentials: {
            username: "owner",
            password: TEST_PASSWORD,
          },
        }),
      },
      { authenticated: false },
    );
    const signIn = (await signInResponse.json()) as { accessToken: string };
    const bearer = { authorization: `Bearer ${signIn.accessToken}` };

    const createdResponse = await fetchCurrent(
      "http://flaremo.test/api/v1/memos",
      {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({
          memo: {
            content: "current wire memo #current",
            visibility: "PUBLIC",
            property: { hasLink: true },
            location: { placeholder: "Shanghai" },
          },
        }),
      },
    );
    expect(createdResponse.status).toBe(200);
    const created = (await createdResponse.json()) as {
      name: string;
      state: string;
      visibility: string;
      createTime: string;
      updateTime: string;
      tags: string[];
      property: { hasLink: boolean };
      location: { placeholder: string };
    };
    expect(created).toMatchObject({
      name: expect.stringMatching(/^memos\//),
      state: "NORMAL",
      visibility: "PUBLIC",
      createTime: expect.any(String),
      updateTime: expect.any(String),
      tags: ["current"],
      property: { hasLink: true },
      location: { placeholder: "Shanghai" },
    });
    expect(created).not.toHaveProperty("create_time");

    const listed = (await (
      await fetchCurrent(
        "http://flaremo.test/api/v1/memos?pageSize=1&orderBy=create_time%20desc",
        { headers: bearer },
      )
    ).json()) as { memos: Array<Record<string, unknown>> };
    expect(listed.memos[0]).toMatchObject({
      name: created.name,
      visibility: "PUBLIC",
    });

    // display_time is the alias third-party sync clients (Obsidian
    // memos-sync) send for creation order; it must not be rejected.
    const listedDisplayTime = (await (
      await fetchCurrent(
        "http://flaremo.test/api/v1/memos?pageSize=1&orderBy=display_time%20desc",
        { headers: bearer },
      )
    ).json()) as { memos: Array<Record<string, unknown>> };
    expect(listedDisplayTime.memos[0]).toMatchObject({ name: created.name });

    const updated = await fetchCurrent(
      `http://flaremo.test/api/v1/${created.name}?updateMask=pinned,visibility`,
      {
        method: "PATCH",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({
          memo: {
            name: created.name,
            pinned: true,
            visibility: "PROTECTED",
          },
        }),
      },
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      name: created.name,
      pinned: true,
      visibility: "PROTECTED",
    });

    const secondResponse = await fetchCurrent(
      "http://flaremo.test/api/v1/memos",
      {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({ memo: { content: "related memo" } }),
      },
    );
    const second = (await secondResponse.json()) as { name: string };

    const attachmentResponse = await fetchCurrent(
      "http://flaremo.test/api/v1/attachments",
      {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({
          attachment: {
            filename: "current.txt",
            content: "aGVsbG8=",
            type: "text/plain",
            memo: created.name,
          },
        }),
      },
    );
    expect(attachmentResponse.status).toBe(200);
    const attachment = (await attachmentResponse.json()) as {
      name: string;
      size: string;
      memo: string;
      type: string;
    };
    expect(attachment).toMatchObject({
      name: expect.stringMatching(/^attachments\//),
      size: "5",
      memo: created.name,
      type: "text/plain",
    });

    const attachmentList = await fetchCurrent(
      "http://flaremo.test/api/v1/attachments?pageSize=10",
      { headers: bearer },
    );
    expect(attachmentList.status).toBe(200);
    expect(await attachmentList.json()).toMatchObject({
      attachments: [expect.objectContaining({ name: attachment.name })],
    });

    const relationResponse = await fetchCurrent(
      `http://flaremo.test/api/v1/${created.name}/relations`,
      {
        method: "PATCH",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({
          name: created.name,
          relations: [
            {
              memo: { name: created.name },
              relatedMemo: { name: second.name },
              type: "REFERENCE",
            },
          ],
        }),
      },
    );
    expect(relationResponse.status).toBe(200);
    const relations = await fetchCurrent(
      `http://flaremo.test/api/v1/${created.name}/relations`,
      { headers: bearer },
    );
    expect(await relations.json()).toMatchObject({
      relations: [
        {
          memo: { name: created.name },
          relatedMemo: { name: second.name },
          type: "REFERENCE",
        },
      ],
    });

    const shareResponse = await fetchCurrent(
      `http://flaremo.test/api/v1/${created.name}/shares`,
      {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({
          parent: created.name,
          memoShare: {},
        }),
      },
    );
    expect(shareResponse.status).toBe(200);
    const share = (await shareResponse.json()) as { name: string };
    const shareToken = share.name.split("/").at(-1);
    expect(shareToken).toBeTruthy();
    const publicShare = await fetchCurrent(
      `http://flaremo.test/api/v1/shares/${shareToken}`,
      undefined,
      { authenticated: false },
    );
    expect(publicShare.status).toBe(200);
    expect(await publicShare.json()).toMatchObject({ name: created.name });

    const patCreate = await fetchCurrent(
      "http://flaremo.test/api/v1/users/owner/personalAccessTokens",
      {
        method: "POST",
        headers: { ...bearer, "content-type": "application/json" },
        body: JSON.stringify({
          description: "current test token",
          expiresInDays: 0,
        }),
      },
    );
    expect(patCreate.status).toBe(200);
    expect(patCreate.headers.get("cache-control")).toBe("no-store");
    const pat = (await patCreate.json()) as {
      personalAccessToken: { name: string };
      token: string;
    };
    expect(pat.personalAccessToken.name).toContain(
      "users/owner/personalAccessTokens/",
    );
    expect(pat.token).toMatch(/^memos_pat_/);

    const invalidPatSignout = await fetchCurrent(
      "http://flaremo.test/api/v1/auth/signout",
      {
        method: "POST",
        headers: { authorization: "Bearer memos_pat_not-a-real-key" },
      },
      { authenticated: false },
    );
    expect(invalidPatSignout.status).toBe(401);

    const validPatSignout = await fetchCurrent(
      "http://flaremo.test/api/v1/auth/signout",
      {
        method: "POST",
        headers: { authorization: `Bearer ${pat.token}` },
      },
      { authenticated: false },
    );
    expect(validPatSignout.status).toBe(200);

    const patList = await fetchCurrent(
      "http://flaremo.test/api/v1/users/owner/personalAccessTokens",
      { headers: bearer },
    );
    expect(patList.status).toBe(200);
    expect(await patList.json()).toMatchObject({
      personalAccessTokens: [
        expect.objectContaining({
          description: "current test token",
        }),
      ],
    });

    const patManagementWithPat = await fetchCurrent(
      "http://flaremo.test/api/v1/users/owner/personalAccessTokens",
      { headers: { authorization: `Bearer ${pat.token}` } },
      { authenticated: false },
    );
    expect(patManagementWithPat.status).toBe(401);

    const unauthenticated = await fetchCurrent(
      "http://flaremo.test/api/v1/memos",
      undefined,
      { authenticated: false },
    );
    expect(unauthenticated.status).toBe(200);
    expect(await unauthenticated.json()).toMatchObject({
      memos: expect.any(Array),
    });
  });

  it("clears the cookie session when current signout receives both credentials", async () => {
    const signInResponse = await fetchCurrent(
      "http://flaremo.test/api/v1/auth/signin",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://flaremo.test",
        },
        body: JSON.stringify({
          passwordCredentials: {
            username: "owner",
            password: TEST_PASSWORD,
          },
        }),
      },
      { authenticated: false },
    );
    const signIn = (await signInResponse.json()) as { accessToken: string };
    const cookie = extractCookieHeader(signInResponse);

    const signout = await fetchCurrent(
      "http://flaremo.test/api/v1/auth/signout",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${signIn.accessToken}`,
          cookie,
          origin: "http://flaremo.test",
        },
      },
      { authenticated: false },
    );
    expect(signout.status).toBe(200);

    const cookieOnly = await fetchCurrent(
      "http://flaremo.test/api/v1/auth/me",
      { headers: { cookie } },
      { authenticated: false },
    );
    expect(cookieOnly.status).toBe(401);
  });

  it("answers malformed JSON bodies with the 400 envelope, not 500", async () => {
    const response = await fetchCurrent("http://flaremo.test/api/v1/memos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not valid json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 3,
      message: "Request body must be valid JSON",
      details: [],
    });
  });
});
