import { test, expect } from '@playwright/test';

test('smoke: page loads with correct title', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Uplink/);
});

test('smoke: header is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#header')).toBeVisible();
});

test('smoke: chat input is visible', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#prompt-input')).toBeVisible();
});

test('smoke: send message and receive response', async ({ page }) => {
  await page.goto('/');

  const input = page.locator('#prompt-input');
  await input.fill('hello');
  await page.locator('#send-btn').click();

  // The mock agent responds with "Hello from mock agent!" via scenarioSimpleText
  const agentMsg = page.locator('.message.agent').first();
  await expect(agentMsg).toBeVisible({ timeout: 10000 });
  await expect(agentMsg.locator('.content')).toContainText('Hello');
});
