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
