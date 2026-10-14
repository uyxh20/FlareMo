import { expect, test } from "@playwright/test";
import { E2E_AUTH_STATE, E2E_EMAIL } from "./auth-fixture";

const TEST_PASSWORD =
  "flaremo-e2e-initial-password-never-use-in-production-2026";

// An expired/absent session at the workspace root must bounce to sign-in
// instead of hanging on the loading screen forever (2026-09-10 regression).
test("bounces an anonymous visitor from the root to sign-in", async ({
  page,
}) => {
  await page.context().clearCookies();

  await page.goto("/");
  await expect(page).toHaveURL(/\/login\?redirect=%2F$/);
  // The loading screen must never be the resting state for anonymous users.
  await expect(page.getByText(/^加载中…$|^Loading…$/)).toHaveCount(0);
});

// The auth guard preserves the deep-linked destination under `redirect`;
// signing in must return the user there instead of the timeline root.
test("returns a deep-linked visitor to their destination after sign-in", async ({
  page,
}) => {
  await page.context().clearCookies();

  await page.goto("/account");
  await expect(page).toHaveURL(/\/login\?redirect=%2Faccount$/);

  // The sign-in field accepts either an email or a username, so its accessible
  // name is "邮箱或用户名" / "Email or username" — not the bare "邮箱" this
  // spec still matched after dual-mode login landed (4d314c8).
  await page
    .getByRole("textbox", { name: /邮箱或用户名|Email or username/i })
    .fill(E2E_EMAIL);
  // `getByLabel`, not `getByRole("textbox")`: the password field renders
  // `<input type="password">`, which has no implicit ARIA role, so a role
  // query can never match it.
  await page.getByLabel(/^密码$|^Password$/i).fill(TEST_PASSWORD);
  await page.getByRole("button", { name: /^登录$|^Sign in$/i }).click();

  await expect(page).toHaveURL(/\/account$/);
  // auth-contract may have rotated the server-side session. Persist the
  // cookie created by this browser login so memo-ui never reads a stale state.
  await page.context().storageState({ path: E2E_AUTH_STATE });
});

// A sign-in whose client-side session confirmation stalls must not strand the
// user on the form: the watchdog falls back to a full document navigation,
// which reads the already-stored cookie directly. This is the 2026-10-10
// support-report shape — sign-in succeeds server-side (session row created),
// but the page never leaves the login form.
test("recovers when the session confirmation stalls after sign-in", async ({
  page,
}) => {
  await page.context().clearCookies();

  // Stall the first session-confirmation request issued after the submit so
  // the client can never confirm before the watchdog fires.
  let stallNextSessionRequest = false;
  await page.route("**/api/auth/get-session*", async (route) => {
    if (!stallNextSessionRequest) {
      await route.continue();
      return;
    }
    stallNextSessionRequest = false;
    await new Promise((resolve) => setTimeout(resolve, 20_000));
    // The reload below aborts this request; continuing a dead route throws.
    await route.continue().catch(() => undefined);
  });

  await page.goto("/login?redirect=%2F");
  await page
    .getByRole("textbox", { name: /邮箱或用户名|Email or username/i })
    .fill(E2E_EMAIL);
  await page.getByLabel(/^密码$|^Password$/i).fill(TEST_PASSWORD);
  stallNextSessionRequest = true;
  await page.getByRole("button", { name: /^登录$|^Sign in$/i }).click();

  // The watchdog fires at 5s and reloads; the fresh document lands in the
  // workspace because the session cookie is already stored.
  await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  await expect(
    page.getByRole("textbox", { name: /new note|新笔记/i }),
  ).toBeVisible({ timeout: 15_000 });
  await page.context().storageState({ path: E2E_AUTH_STATE });
});

// A resource 401 while the session itself is still valid must not strand the
// workspace on the loading screen. The guard latches on the auth-required
// event, then confirms the real session again — a user that is still signed
// in returns to the workspace without a manual reload (2026-10-10 report:
// the latch previously stayed set until a window-focus refetch happened to
// run).
test("recovers from an auth-required event while the session is valid", async ({
  page,
}) => {
  await page.goto("/");
  const composer = page.getByRole("textbox", {
    name: /new note|新笔记/i,
  });
  await expect(composer).toBeVisible();

  await page.evaluate(() => {
    window.dispatchEvent(new Event("flaremo:authentication-required"));
  });

  // The guard releases once the re-confirmed session lands; the workspace
  // must come back on its own.
  await expect(composer).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/\/$/);
});
