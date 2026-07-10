import { expect, test } from "@playwright/test";

test("judge can replay an explainable signal through settlement", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("SIMULATION ONLY — NO REAL MONEY")).toBeVisible();
  await expect(page.getByText("Synthetic demo data — not a real match")).toBeVisible();

  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByText("No material movement yet")).toBeVisible();
  for (let index = 0; index < 5; index += 1) {
    await page.getByRole("button", { name: "Next event" }).click();
  }
  await expect(page.getByText("Simulated confirmation position opened")).toBeVisible();
  await expect(page.getByText("Latest confirmed match event", { exact: true })).toBeVisible();
  await expect(page.getByText("HEALTHY", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Next event" }).click();
  await expect(page.getByText("duplicate update", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Next event" }).click();
  await page.getByRole("button", { name: "Next event" }).click();
  await expect(page.getByText("stale feed", { exact: true })).toBeVisible();
  await expect(page.getByText("sequence gap", { exact: true })).toBeVisible();
  await expect(page.getByText("DEGRADED", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Next event" }).click();
  await expect(page.getByText("out of order update", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Next event" }).click();
  await expect(page.getByText("delayed update", { exact: true })).toBeVisible();
  await expect(page.getByText("feed recovery", { exact: true })).toBeVisible();

  await page.getByLabel("Speed").selectOption("10");
  await page.getByRole("button", { name: "Start" }).click();
  await expect(
    page.getByRole("heading", { name: "+15.60 virtual units", exact: true })
  ).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("settled", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open signal detail →" }).click();
  await expect(page.getByText("SIGNAL DETAIL")).toBeVisible();
  await expect(page.getByText("Movement persisted", { exact: true })).toBeVisible();
  await expect(page.getByText(/^30s persisted/)).toBeVisible();
  await expect(page.getByText(/^60s persisted/)).toBeVisible();
  await expect(page.getByText(/^300s persisted/)).toBeVisible();
  await expect(page.getByText("Entry comparison: equal", { exact: true })).toBeVisible();
  await expect(page.getByText("SIMULATION ONLY — NO REAL MONEY")).toBeVisible();
});
