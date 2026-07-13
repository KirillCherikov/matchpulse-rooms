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
  await expect(page.getByRole("heading", { name: "Rule-based score components" })).toBeVisible();
  await expect(page.getByText("Strategy 2026-07-replay-mvp", { exact: true })).toBeVisible();
  await expect(page.getByText("base", { exact: true })).toBeVisible();
  await expect(page.getByText("+32.0 pp", { exact: true })).toBeVisible();
  await expect(page.getByText("Movement persisted", { exact: true })).toBeVisible();
  await expect(page.getByText(/^30s persisted/)).toBeVisible();
  await expect(page.getByText(/^60s persisted/)).toBeVisible();
  await expect(page.getByText(/^300s persisted/)).toBeVisible();
  await expect(page.getByText("Entry comparison: immediate", { exact: true })).toBeVisible();
  await expect(page.getByText("SIMULATION ONLY — NO REAL MONEY")).toBeVisible();
});

test("judge can inspect live devnet status without disrupting replay", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "SYNTHETIC REPLAY", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "LIVE DEVNET TXLINE", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "LIVE DEVNET TXLINE", exact: true }).first()
  ).toBeVisible();
  await expect(page.getByText("SOLANA DEVNET", { exact: true })).toBeVisible();
  await expect(
    page.getByText(/Live devnet is not enabled|Stream connected, awaiting data/)
  ).toBeVisible();

  await page.getByRole("button", { name: "SYNTHETIC REPLAY", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next event", exact: true })).toBeVisible();
});

test("judge can inspect an authenticated verified live status and return to replay", async ({
  page
}) => {
  await page.route("**/api/live/status", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        network: "solana-devnet",
        connected: true,
        authenticated: true,
        connectionStatus: "connected",
        awaitingData: true,
        latestFixture: {
          id: "18143850",
          competition: "Sanitized official-shape competition",
          homeTeam: "Test Home",
          awayTeam: "Test Away",
          status: "scheduled",
          scheduledStartTimestamp: "2026-07-13T08:00:00.000Z",
          sourceTimestamp: "2026-07-13T07:00:00.000Z",
          receivedTimestamp: "2026-07-13T07:00:00.100Z",
          rawReference: "txline://fixtures/18143850/1783926000000",
          dataLabel: "Live TxLINE devnet data"
        },
        latestOddsTimestamp: "2026-07-13T07:00:00.000Z",
        latestScoreTimestamp: "2026-07-13T07:00:01.000Z",
        streams: {
          odds: {
            status: "connected",
            lastHeartbeatAt: "2026-07-13T07:00:02.000Z",
            reconnectAttempt: 0
          },
          scores: {
            status: "connected",
            lastHeartbeatAt: "2026-07-13T07:00:02.000Z",
            reconnectAttempt: 0
          }
        },
        verification: {
          status: "verified",
          method: "validateFixture",
          checkedAt: "2026-07-13T07:00:03.000Z",
          fixtureId: "18143850",
          proofTimestamp: "2026-07-13T07:00:00.000Z",
          programId: "6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J",
          rootAccount: "AzB6fHDNvTThdvQazWvYfgsCbDm6Ksi3zP5BzoxYo5Ri",
          sourceCommit: "9b2de4c30cf0f4e01c88d73c365543276d065cf2",
          idlVersion: "1.5.6",
          rpcSlot: 123456,
          computeUnits: 45678,
          simulation: "read-only-unsigned"
        },
        updatedAt: "2026-07-13T07:00:03.000Z"
      })
    });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "LIVE DEVNET TXLINE", exact: true }).click();

  await expect(page.getByText("AUTHENTICATED", { exact: true })).toBeVisible();
  await expect(page.getByText("VERIFIED", { exact: true })).toBeVisible();
  await expect(page.getByText("Stream connected, awaiting data", { exact: true })).toBeVisible();
  await expect(page.getByText("Test Home vs Test Away", { exact: true })).toBeVisible();
  await expect(page.getByText(/Root AzB6fHDNvTThdvQazWvYfgsCbDm6Ksi3zP5BzoxYo5Ri/)).toBeVisible();
  await expect(page.getByText(/slot 123456 · 45678 CU · proof/)).toBeVisible();
  await expect(page.getByText(/fixture 18143850 · checked/)).toBeVisible();
  await expect(page.getByText(/read-only-unsigned/)).toBeVisible();
  await expect(page.getByText(/IDL 1.5.6/)).toBeVisible();
  await expect(page.getByText(/9b2de4c30cf0f4e01c88d73c365543276d065cf2/)).toBeVisible();
  await expect(page.getByText("No transport error reported", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "SYNTHETIC REPLAY", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next event", exact: true })).toBeVisible();
});
