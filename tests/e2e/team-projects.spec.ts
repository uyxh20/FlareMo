import { expect, test } from "@playwright/test";
import { E2E_BASE_URL } from "./auth-fixture";

// Added to the opt-in memo-ui project; deliberately not run as part of the
// targeted unit gate. The standard E2E fixture owns a disposable local DB.
test("anonymous team-project deep link keeps its destination through sign-in", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/team-projects?view=all");
  await expect(page).toHaveURL(/\/login\?redirect=/);
  const redirected = new URL(page.url()).searchParams.get("redirect");
  expect(redirected).toBe("/team-projects?view=all");
});

test("team project detail refresh and return keep a list filter, while personal projects remain separate", async ({
  page,
}) => {
  const marker = `Team route ${Date.now()}`;
  const content = `\`\`\`kosx-pm\n${JSON.stringify({
    schema: "kosx.pm/1",
    kind: "project",
    name: marker,
    phase: "planned",
    phase_history: [],
    client_submission_id: crypto.randomUUID(),
  })}\n\`\`\``;
  const created = await page.request.post("/api/app/memos", {
    headers: { origin: E2E_BASE_URL },
    data: { content, visibility: "protected", source: "team-projects-e2e" },
  });
  expect(created.ok()).toBe(true);
  const memo = (await created.json()) as { name: string };
  const id = memo.name.replace(/^memos\//, "");

  await page.goto("/team-projects?view=all");
  await expect(
    page
      .locator(".pm-content")
      .getByRole("heading", { name: /团队项目|Team projects/i }),
  ).toBeVisible();
  await page.locator(".pm-project").filter({ hasText: marker }).click();
  await expect(page).toHaveURL(new RegExp(`/team-projects\\?project=${id}`));
  await page.reload();
  await expect(page.getByRole("heading", { name: marker })).toBeVisible();
  await page
    .getByRole("button", { name: /编辑项目信息|Edit project information/i })
    .click();
  await expect(page).toHaveURL(/edit=true/);
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: /编辑项目信息|Edit project information/i,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: /返回|Back/i }).click();
  await expect(page.getByRole("heading", { name: marker })).toBeVisible();
  await page.getByRole("button", { name: /返回总览|Back to projects/ }).click();
  await expect(page).toHaveURL(/\/team-projects\?view=all/);

  await page.goto("/projects");
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByText(marker)).toHaveCount(0);
});
