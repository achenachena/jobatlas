import { expect, test } from "@playwright/test";

/** Live smoke test against a running API with real data (LIVE=1). An unavailable service
 * fails this test; it is never reported as a pass. */
test.skip(!process.env.LIVE, "set LIVE=1 to run against the real API");

test("live: real data loads, a job opens with an official apply link", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /^View list of \d+ jobs/ }).click({ timeout: 30_000 });
  await page.locator("button[data-job-id]").first().click();
  const apply = page.getByRole("link", { name: /Apply on employer site/ });
  await expect(apply).toHaveAttribute("href", /^https?:\/\//);
});
