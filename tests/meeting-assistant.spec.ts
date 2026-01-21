import { expect, test } from "@playwright/test";

test("runs meeting assistant with demo audio", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");

  const topics = page.locator("[data-testid^=topic-]");
  await expect(topics).toHaveCount(4);

  await page.getByRole("button", { name: "Demo audio" }).click();
  await page.getByTestId("start-meeting").click();

  await expect(page.getByTestId("timer-value")).toBeVisible();

  await expect
    .poll(async () => page.getByTestId("transcript-entry").count(), {
      timeout: 120000,
    })
    .toBeGreaterThan(0);

  await expect
    .poll(
      async () => {
        const hasTopic = await page
          .getByTestId("classification-topic")
          .isVisible()
          .catch(() => false);
        const hasError = await page
          .getByTestId("classification-error")
          .isVisible()
          .catch(() => false);
        return hasTopic || hasError;
      },
      { timeout: 120000 },
    )
    .toBe(true);
});
