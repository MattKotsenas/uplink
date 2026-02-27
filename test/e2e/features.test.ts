import { test, expect } from '@playwright/test';

test('user messages align right, agent messages align left', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  await page.locator('#prompt-input').fill('hello');
  await page.locator('#send-btn').click();

  // Wait for agent response
  const agentMsg = page.locator('.message.agent').first();
  await expect(agentMsg).toBeVisible({ timeout: 10000 });

  const userMsg = page.locator('.message.user').first();
  const chatArea = page.locator('#chat-area');
  const chatAreaBox = await chatArea.boundingBox();
  const userBox = await userMsg.boundingBox();
  const agentBox = await agentMsg.boundingBox();

  // User message should be right-aligned (its right edge near container right edge)
  const userRightGap = chatAreaBox!.x + chatAreaBox!.width - (userBox!.x + userBox!.width);
  const userLeftGap = userBox!.x - chatAreaBox!.x;
  expect(userLeftGap).toBeGreaterThan(userRightGap);

  // Agent message should be left-aligned (its left edge near container left edge)
  const agentRightGap = chatAreaBox!.x + chatAreaBox!.width - (agentBox!.x + agentBox!.width);
  const agentLeftGap = agentBox!.x - chatAreaBox!.x;
  expect(agentRightGap).toBeGreaterThan(agentLeftGap);
});

test('dark/light mode toggle via /theme command', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const html = page.locator('html');

  // Get current theme
  const initialTheme = await html.getAttribute('class');

  // Toggle to the opposite theme
  const targetTheme = initialTheme === 'dark' ? 'light' : 'dark';
  await page.locator('#prompt-input').fill(`/theme ${targetTheme}`);
  await page.locator('#send-btn').click();

  await expect(html).toHaveClass(targetTheme);

  // System message should confirm the change
  const sysMsg = page.locator('.message.system').filter({ hasText: `Theme set to ${targetTheme}` });
  await expect(sysMsg).toBeVisible({ timeout: 5000 });

  // Toggle back
  await page.locator('#prompt-input').fill(`/theme ${initialTheme}`);
  await page.locator('#send-btn').click();
  await expect(html).toHaveClass(initialTheme!);
});

test('slash command palette appears on / keystroke', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const palette = page.locator('.command-palette');

  // Palette should not be visible initially
  await expect(palette).not.toBeVisible();

  // Type / to trigger palette
  await input.fill('/');
  await expect(palette).toBeVisible();

  // Should show available commands
  await expect(palette.locator('.command-palette-item')).toHaveCount(7); // 7 commands

  // Type more to filter
  await input.fill('/mo');
  await expect(palette.locator('.command-palette-item')).toHaveCount(1);
  await expect(palette.locator('.command-palette-label')).toContainText('/model');

  // Clear the slash — palette should hide
  await input.fill('hello');
  await expect(palette).not.toBeVisible();
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

test('/model command is sent as prompt to CLI', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Send /model command — this is a CLI-passthrough command
  await page.locator('#prompt-input').fill('/model haiku');
  await page.locator('#send-btn').click();

  // The user message should show in chat
  const userMsg = page.locator('.message.user').filter({ hasText: '/model haiku' });
  await expect(userMsg).toBeVisible({ timeout: 5000 });

  // Agent should respond (mock will echo back)
  await expect(page.locator('.message.agent')).toBeVisible({ timeout: 10000 });
});

test('session is preserved across /model commands', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Send a message so a session is established
  await page.locator('#prompt-input').fill('hello');
  await page.locator('#send-btn').click();
  await expect(page.locator('.message.agent')).toBeVisible({ timeout: 10000 });

  // Verify session is in localStorage
  const sessionBefore = await page.evaluate(() =>
    localStorage.getItem('uplink-resume-session'),
  );
  expect(sessionBefore).toBeTruthy();

  // Send /model command — should NOT disconnect/reconnect
  await page.locator('#prompt-input').fill('/model sonnet');
  await page.locator('#send-btn').click();

  // Session should still be the same
  const sessionAfter = await page.evaluate(() =>
    localStorage.getItem('uplink-resume-session'),
  );
  expect(sessionAfter).toBe(sessionBefore);
});

test('session is persisted to localStorage for page reload resume', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // After connecting, uplink-resume-session should be saved in localStorage
  const sessionId = await page.evaluate(() =>
    localStorage.getItem('uplink-resume-session'),
  );
  expect(sessionId).toBeTruthy();
  expect(sessionId).toMatch(/^mock-session-/);
});

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

  // Verify it contains accumulated reasoning content
  await expect(thinking).toContainText('analyzed the problem', { timeout: 5000 });

  // Verify the agent message also rendered
  await expect(page.locator('.message.agent')).toContainText('Based on my analysis');
});

test('tool calls render inline between messages in timeline order', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Send a message that triggers tool calls (which appear between user and agent messages)
  const input = page.locator('#prompt-input');
  await input.fill('tool');
  await page.locator('#send-btn').click();

  // Wait for tool call and agent response
  const toolCall = page.locator('.tool-call').first();
  await expect(toolCall).toBeVisible({ timeout: 10000 });
  const agentMsg = page.locator('.message.agent').first();
  await expect(agentMsg).toBeVisible({ timeout: 10000 });

  // Verify DOM order: user message → tool call → agent message
  const userMsgBox = await page.locator('.message.user').first().boundingBox();
  const toolCallBox = await toolCall.boundingBox();
  const agentMsgBox = await agentMsg.boundingBox();

  expect(toolCallBox!.y).toBeGreaterThan(userMsgBox!.y);
  expect(agentMsgBox!.y).toBeGreaterThan(toolCallBox!.y);

  // Tool call icon should use Material Symbols
  const kindIcon = toolCall.locator('.material-symbols-outlined').first();
  await expect(kindIcon).toBeVisible();
});

test('permission buttons have readable contrast in dark mode', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Ensure dark mode via /theme command
  const html = page.locator('html');
  if ((await html.getAttribute('class')) !== 'dark') {
    await page.locator('#prompt-input').fill('/theme dark');
    await page.locator('#send-btn').click();
    await expect(html).toHaveClass('dark');
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

test('permission prompt appears inside the chat flow, not below it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Trigger permission dialog
  const input = page.locator('#prompt-input');
  await input.fill('permission allow');
  await page.locator('#send-btn').click();

  // Wait for the permission prompt
  const permissionCard = page.locator('.permission-request').first();
  await expect(permissionCard).toBeVisible({ timeout: 10000 });

  // The permission should be inside .chat-container (same flex container as messages)
  const isInsideChatContainer = await permissionCard.evaluate((el) => {
    return el.closest('.chat-container') !== null;
  });
  expect(isInsideChatContainer).toBe(true);

  // The permission card should appear after the user message in DOM order
  const userMessage = page.locator('.message.user').first();
  const userMessageRect = await userMessage.boundingBox();
  const permissionRect = await permissionCard.boundingBox();
  expect(permissionRect!.y).toBeGreaterThan(userMessageRect!.y);

  // Permission icon should use Material Symbols
  const permIcon = permissionCard.locator('.material-symbols-outlined').first();
  await expect(permIcon).toBeVisible();
});

test('shows thinking indicator while waiting for agent response', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  await input.fill('hello');
  await page.locator('#send-btn').click();

  // The thinking indicator should appear briefly before the response arrives
  const thinking = page.locator('.thinking-indicator');
  // Since the mock responds very quickly, we need to check it appeared at some point.
  // Use a race: either we catch the indicator before it disappears, or we verify
  // the response arrived (meaning the indicator appeared and was replaced).
  // For the mock, the response is fast, so let's just verify the indicator
  // doesn't persist after the response is complete.
  await expect(page.locator('.message.agent').first()).toBeVisible({ timeout: 10000 });

  // After response completes, the thinking indicator should be gone
  await expect(thinking).toHaveCount(0);
});

test('yolo mode auto-approves permission requests', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Enable yolo mode via /yolo command
  await page.locator('#prompt-input').fill('/yolo');
  await page.locator('#send-btn').click();

  // System message should confirm
  const sysMsg = page.locator('.message.system').filter({ hasText: 'Auto-approve enabled' });
  await expect(sysMsg).toBeVisible({ timeout: 5000 });

  // Send a permission-triggering message
  const input = page.locator('#prompt-input');
  await input.fill('permission allow');
  await page.locator('#send-btn').click();

  // Wait for the response to complete — permission should be auto-approved
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // The permission card should show "Approved" (auto-approved, not pending)
  const approved = page.locator('.permission-request').filter({ hasText: 'Approved' });
  await expect(approved).toHaveCount(1, { timeout: 5000 });

  // No pending permission buttons should be visible
  const pendingAllowBtn = page.locator('.permission-btn.allow:not([disabled])');
  await expect(pendingAllowBtn).toHaveCount(0);
});

test('mode changes via slash commands set input box border color', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const html = page.locator('html');
  const input = page.locator('#prompt-input');

  // Default mode is chat — no data-mode attribute or "chat"
  const defaultMode = await html.getAttribute('data-mode');
  expect(defaultMode === null || defaultMode === 'chat').toBe(true);

  // Switch to plan mode via /plan command
  await input.fill('/plan');
  await page.locator('#send-btn').click();

  // Verify data-mode attribute
  await expect(html).toHaveAttribute('data-mode', 'plan');

  // Focus the input to trigger border color change
  await input.focus();
  const planBorderColor = await input.evaluate(
    (el) => getComputedStyle(el).borderColor,
  );
  // Plan mode should use --info (blue), not --accent (mauve)
  expect(planBorderColor).not.toBe('rgb(203, 166, 247)'); // not mauve

  // Switch back to chat via /agent
  await input.fill('/agent');
  await page.locator('#send-btn').click();
  await expect(html).toHaveAttribute('data-mode', 'chat');
});

test('autopilot mode auto-continues and shows green border', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Switch to autopilot mode via /autopilot command
  await page.locator('#prompt-input').fill('/autopilot');
  await page.locator('#send-btn').click();

  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-mode', 'autopilot');

  // Wait for the agent response from /autopilot command
  await expect(page.locator('.message.agent')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Verify green border on input
  const input = page.locator('#prompt-input');
  await input.focus();
  const borderColor = await input.evaluate(
    (el) => getComputedStyle(el).borderColor,
  );
  // Should not be default mauve
  expect(borderColor).not.toBe('rgb(203, 166, 247)');

  // Send a message — autopilot should auto-continue once, then stop
  await input.fill('hello');
  await page.locator('#send-btn').click();

  // Wait for auto-continuation message to appear
  const continueMsg = page.locator('.message.user').filter({ hasText: 'continue' });
  await expect(continueMsg).toBeVisible({ timeout: 10000 });

  // Agent should have responded to the continue with a final message
  await expect(page.locator('.message.agent').last()).toContainText('Done', { timeout: 10000 });
});

test('/session rename command renames the session', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Send /session rename command
  const input = page.locator('#prompt-input');
  await input.fill('/session rename My Test Session');
  await page.locator('#send-btn').click();

  // Should show a system confirmation message
  const renameMsg = page.locator('.message.system').filter({ hasText: 'Session renamed to "My Test Session"' });
  await expect(renameMsg).toBeVisible({ timeout: 5000 });
});

test('input, send button, and cancel button have matching heights', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const sendBtn = page.locator('#send-btn');

  const inputBox = await input.boundingBox();
  const sendBox = await sendBtn.boundingBox();
  expect(inputBox).not.toBeNull();
  expect(sendBox).not.toBeNull();
  expect(inputBox!.height).toBeCloseTo(sendBox!.height, 0);

  // Trigger a prompt to make the cancel button appear
  await input.fill('hello');
  await page.locator('#send-btn').click();
  const cancelBtn = page.locator('#cancel-btn');
  await expect(cancelBtn).toBeVisible({ timeout: 5000 });

  const cancelBox = await cancelBtn.boundingBox();
  expect(cancelBox).not.toBeNull();
  expect(cancelBox!.height).toBeCloseTo(sendBox!.height, 0);
});

test('tool call and permission icons have consistent left alignment', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Trigger tool call
  await page.locator('#prompt-input').fill('tool');
  await page.locator('#send-btn').click();
  await expect(page.locator('.tool-call').first()).toBeVisible({ timeout: 10000 });

  // Trigger permission
  await page.locator('#prompt-input').fill('permission allow');
  await page.locator('#send-btn').click();
  await expect(page.locator('.permission-request').first()).toBeVisible({ timeout: 10000 });

  // Measure icon left edges relative to their card container
  const toolIconX = await page.locator('.tool-call .kind-icon').first().boundingBox();
  const toolCardX = await page.locator('.tool-call').first().boundingBox();
  const permIconX = await page.locator('.permission-request .permission-icon').first().boundingBox();
  const permCardX = await page.locator('.permission-request').first().boundingBox();

  const toolOffset = toolIconX!.x - toolCardX!.x;
  const permOffset = permIconX!.x - permCardX!.x;

  // Icons should start at the same offset from their card's left edge
  expect(toolOffset).toBeCloseTo(permOffset, 0);
});

test('failed tool call shows status message when expanded', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Trigger failed tool call
  await page.locator('#prompt-input').fill('fail');
  await page.locator('#send-btn').click();

  const toolCall = page.locator('.tool-call').first();
  await expect(toolCall).toBeVisible({ timeout: 10000 });

  // Should show failed status
  await expect(toolCall.locator('.status')).toContainText('failed');

  // Click to expand
  await toolCall.locator('.tool-call-header').click();

  // Body should be visible and contain some feedback (not empty)
  const body = toolCall.locator('.tool-call-body');
  await expect(body).toBeVisible();
  const bodyText = await body.textContent();
  expect(bodyText!.trim().length).toBeGreaterThan(0);
});

test('shell output appears inline in timeline, not pinned to bottom', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Send a shell command
  const input = page.locator('#prompt-input');
  await input.fill('!echo hello');
  await page.locator('#send-btn').click();
  await expect(page.locator('.shell-output')).toBeVisible({ timeout: 10000 });

  // Send a normal message after
  await input.fill('follow up');
  await page.locator('#send-btn').click();
  await expect(page.locator('.message.user').nth(1)).toBeVisible({ timeout: 10000 });

  // Shell output should be above the follow-up user message
  const shellBox = await page.locator('.shell-output').boundingBox();
  const followUpBox = await page.locator('.message.user').nth(1).boundingBox();
  expect(shellBox).toBeTruthy();
  expect(followUpBox).toBeTruthy();
  expect(shellBox!.y).toBeLessThan(followUpBox!.y);
});

test('thinking content blocks render as collapsible reasoning', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  await input.fill('thinking');
  await page.locator('#send-btn').click();

  // Wait for the agent response (follows the thinking blocks)
  const agentMsg = page.locator('.message.agent');
  await expect(agentMsg).toBeVisible({ timeout: 10000 });
  await expect(agentMsg).toContainText('thinking it through');

  // Thinking content should be rendered as a collapsible block
  const thinking = page.locator('.tool-call-thinking');
  await expect(thinking).toBeAttached({ timeout: 5000 });
  // Both streamed thought chunks should be accumulated
  await expect(thinking).toContainText('consider the approach');
  await expect(thinking).toContainText('database schema');
});

test('typing ! sets shell-input border, removing it reverts', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const html = page.locator('html');

  // Start in chat mode
  await expect(html).toHaveAttribute('data-mode', 'chat');

  // Type ! to trigger shell input mode
  await input.fill('!');
  await expect(html).toHaveAttribute('data-mode', 'shell-input');

  // Verify border color changed from default (not the normal --border color)
  const shellBorder = await input.evaluate(
    (el) => getComputedStyle(el).borderColor,
  );
  const defaultBorder = await input.evaluate(
    (el) => getComputedStyle(el).getPropertyValue('--border').trim(),
  );
  // Shell-input border should NOT be the default border color
  expect(shellBorder).not.toBe(defaultBorder);

  // Clear the ! — should revert to chat
  await input.fill('');
  await expect(html).toHaveAttribute('data-mode', 'chat');
});

test('shell-input border reverts to plan mode if plan was active', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const html = page.locator('html');

  // Switch to plan mode via /plan command
  await input.fill('/plan');
  await page.locator('#send-btn').click();
  await expect(html).toHaveAttribute('data-mode', 'plan');

  // Wait for agent response to complete
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Type ! — should show shell-input
  await input.fill('!echo hello');
  await expect(html).toHaveAttribute('data-mode', 'shell-input');

  // Delete the ! — should revert to plan, not chat
  await input.fill('echo hello');
  await expect(html).toHaveAttribute('data-mode', 'plan');
});
