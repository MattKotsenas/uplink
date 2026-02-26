import { test, expect } from '@playwright/test';

test('dark/light mode toggle', async ({ page }) => {
  await page.goto('/');

  const html = page.locator('html');
  const initialTheme = await html.getAttribute('class');

  // Open hamburger menu to access theme toggle
  await page.locator('#menu-toggle').click();
  const themeToggle = page.locator('#theme-toggle');

  // Toggle theme
  await themeToggle.click();
  const toggledTheme = initialTheme === 'dark' ? 'light' : 'dark';
  await expect(html).toHaveClass(toggledTheme);

  // Re-open menu and toggle back
  await page.locator('#menu-toggle').click();
  await themeToggle.click();
  await expect(html).toHaveClass(initialTheme!);
});

test('shell command execution', async ({ page }) => {
  await page.goto('/');

  // Wait for the connection to be ready
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  await input.fill('!echo hello world');
  await page.locator('#send-btn').click();

  const shellOutput = page.locator('.shell-output');
  await expect(shellOutput).toBeVisible({ timeout: 10000 });
  await expect(shellOutput.locator('.stdout')).toContainText('hello world');
});

test('chat renders after model change', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Send a message and verify it renders
  await page.locator('#prompt-input').fill('hello');
  await page.locator('#send-btn').click();
  await expect(page.locator('.message.agent')).toBeVisible({ timeout: 10000 });

  // Change model (triggers clearConversation)
  await page.locator('#menu-toggle').click();
  await page.locator('#model-select').selectOption('claude-sonnet-4.6');

  // Wait for reconnection
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Send another message and verify it renders
  await page.locator('#prompt-input').fill('after model change');
  await page.locator('#send-btn').click();
  await expect(page.locator('.message.user')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.message.agent')).toBeVisible({ timeout: 10000 });
});

test('model change resumes same session', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Intercept localStorage.setItem to capture the resume session ID
  await page.evaluate(() => {
    (window as any).__capturedResumeId = null;
    const origSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key: string, value: string) {
      if (key === 'uplink-resume-session') {
        (window as any).__capturedResumeId = value;
      }
      return origSetItem.call(this, key, value);
    };
  });

  // Send a message so a session is established
  await page.locator('#prompt-input').fill('hello');
  await page.locator('#send-btn').click();
  await expect(page.locator('.message.agent')).toBeVisible({ timeout: 10000 });

  // Change model — should save session for resume
  await page.locator('#menu-toggle').click();
  await page.locator('#model-select').selectOption('claude-sonnet-4.6');

  // Wait for reconnection
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Verify a resume session ID was saved
  const resumeId = await page.evaluate(() => (window as any).__capturedResumeId);
  expect(resumeId).toBeTruthy();
  expect(resumeId).toMatch(/^mock-session-/);
});

// TODO: This test is flaky — the mock agent sends "I've analyzed the problem..." in a
// tool_call_update, but the Preact component may replace or re-render the content before
// the assertion runs. Investigate whether tool_call_update handling has a race with rendering.
test('thinking/reasoning display', async ({ page }) => {
  await page.goto('/');

  // Wait for the connection to be ready
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  await input.fill('reason');
  await page.locator('#send-btn').click();

  // Wait for the thinking element to appear in the DOM
  const thinking = page.locator('.tool-call-thinking');
  await expect(thinking).toBeAttached({ timeout: 10000 });

  // Verify it's a <details> element
  const tagName = await thinking.evaluate(el => el.tagName.toLowerCase());
  expect(tagName).toBe('details');

  // Verify it contains reasoning content
  await expect(thinking).toContainText('analyzed the problem', { timeout: 5000 });
});

test('permission buttons have readable contrast in dark mode', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Ensure dark mode
  const html = page.locator('html');
  if ((await html.getAttribute('class')) !== 'dark') {
    await page.locator('#menu-toggle').click();
    await page.locator('#theme-toggle').click();
  }

  // Trigger permission dialog
  const input = page.locator('#prompt-input');
  await input.fill('permission allow');
  await page.locator('#send-btn').click();

  // Wait for the allow button to appear
  const allowBtn = page.locator('.permission-btn.allow').first();
  await expect(allowBtn).toBeVisible({ timeout: 10000 });

  // Verify text color is NOT white — should be a dark color for contrast
  const color = await allowBtn.evaluate(
    (el) => getComputedStyle(el).color,
  );
  // White is rgb(255, 255, 255) — we want dark text instead
  expect(color).not.toBe('rgb(255, 255, 255)');
});
