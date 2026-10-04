import { expect, type Page, test } from "@playwright/test";

async function collectHydrationErrors(page: Page) {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

function expectNoHydrationErrors(errors: string[]) {
  expect(
    errors.filter((message) =>
      /Minified React error #418|Hydration failed|hydration|did not match/i.test(
        message,
      ),
    ),
  ).toEqual([]);
}

async function waitForHydratedControls(page: Page) {
  const trigger = page.getByRole("button", {
    name: "切换主题 / Switch theme",
  });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
}

test("homepage can reach the static docs index", async ({ page }) => {
  const errors = await collectHydrationErrors(page);
  await page.goto("/");
  await expect(page.getByRole("main")).toHaveCount(1);
  await waitForHydratedControls(page);

  await page.getByRole("link", { name: "Docs", exact: true }).first().click();
  await expect(page).toHaveURL(/\/docs\/?$/);
  await expect(
    page.getByRole("heading", { name: "Documentation" }),
  ).toBeVisible();
  await expect(page.getByRole("main")).toHaveCount(1);
  expectNoHydrationErrors(errors);
});

for (const route of [
  {
    path: "/docs/deploy",
    heading: "Deploying FlareMo",
    body: "FlareMo deploys to Cloudflare Workers.",
  },
  {
    path: "/zh/docs/deploy",
    heading: "部署 FlareMo",
    body: "FlareMo 部署到 Cloudflare Workers。",
  },
]) {
  test(`direct ${route.path} keeps the prerendered article during hydration`, async ({
    page,
  }) => {
    const errors = await collectHydrationErrors(page);
    await page.goto(route.path);

    await expect(page.locator("main h1")).toHaveCount(1);
    await expect(page.locator("main h1").first()).toHaveText(route.heading);
    await expect(page.locator("main article").first()).toContainText(
      route.body,
    );
    await expect(page.getByRole("main")).toHaveCount(1);
    await waitForHydratedControls(page);
    expectNoHydrationErrors(errors);
  });
}

test("mobile docs keeps its directory collapsed until requested", async ({
  page,
}) => {
  const errors = await collectHydrationErrors(page);
  await page.setViewportSize({ height: 844, width: 390 });
  await page.goto("/zh/docs/deploy");

  const directory = page.locator("aside details");
  await expect(directory).toBeVisible();
  await expect(directory).not.toHaveAttribute("open", "");

  const summary = directory.locator("summary");
  await summary.focus();
  await page.keyboard.press("Enter");
  await expect(directory).toHaveAttribute("open", "");
  await expect(directory.locator("nav")).toBeVisible();
  await directory.getByRole("link", { name: "维护手册", exact: true }).click();
  await expect(page).toHaveURL(/\/zh\/docs\/maintenance\/?$/);
  await expect(directory).not.toHaveAttribute("open", "");

  await waitForHydratedControls(page);
  expectNoHydrationErrors(errors);
});
