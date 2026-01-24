import { expect, test } from "@playwright/test";

test("manages agendas without starting a meeting", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/");

  const agendaPicker = page.getByTestId("agenda-picker");
  await expect(agendaPicker).toHaveValue("demo");

  await page.getByTestId("topic-edit-welcome").click();
  const topicEditor = page.getByTestId("topic-editor");
  await expect(topicEditor).toBeVisible();

  const [titleInput, minutesInput] = await topicEditor.locator("input").all();
  await titleInput.fill("Kickoff");
  await minutesInput.fill("4");
  await topicEditor.locator("textarea").fill("Confirm goals");
  await page.getByTestId("topic-save-welcome").click();
  await expect(page.getByTestId("topic-welcome")).toContainText("Kickoff");

  const newAgendaTitle = `Agenda ${Date.now()}`;
  await page
    .getByTestId("agenda-picker")
    .selectOption({ label: "+ New agenda" });
  await page.getByLabel("New agenda name").fill(newAgendaTitle);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(agendaPicker.locator("option:checked")).toHaveText(
    newAgendaTitle,
  );

  await page.reload();
  await expect(agendaPicker).toHaveValue("demo");
  await expect(
    agendaPicker.locator(`option:has-text("${newAgendaTitle}")`),
  ).toHaveCount(1);
});
