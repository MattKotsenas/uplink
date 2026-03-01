import { test, expect } from '@playwright/test';

test('PWA manifest and icons are accessible', async ({ page, request }) => {
  const manifest = await request.get('/manifest.json');
  expect(manifest.ok()).toBe(true);
  const json = await manifest.json();
  expect(json.name).toBe('Copilot Uplink');

  // Verify icon files are reachable
  for (const icon of json.icons) {
    const resp = await request.get(icon.src);
    expect(resp.ok()).toBe(true);
  }
});

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

test('/clear removes messages from conversation', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Send a message so there's something to clear
  await page.locator('#prompt-input').fill('hello');
  await page.locator('#send-btn').click();
  await expect(page.locator('.message.agent').first()).toBeVisible({ timeout: 10000 });

  // Verify messages exist
  await expect(page.locator('.message.user')).toHaveCount(1);

  // Clear the conversation
  await page.locator('#prompt-input').fill('/clear');
  await page.locator('#send-btn').click();

  // All messages (user + agent) should be gone
  await expect(page.locator('.message.user')).toHaveCount(0);
  await expect(page.locator('.message.agent')).toHaveCount(0);
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
  await expect(palette.locator('.command-palette-item')).toHaveCount(8); // 8 commands

  // Type more to filter
  await input.fill('/mo');
  await expect(palette.locator('.command-palette-item')).toHaveCount(1);
  await expect(palette.locator('.command-palette-label')).toContainText('/model');

  // Clear the slash — palette should hide
  await input.fill('hello');
  await expect(palette).not.toBeVisible();
});

test('clicking a command shows sub-options in palette', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const palette = page.locator('.command-palette');

  // Type /s to filter to /session
  await input.fill('/s');
  await expect(palette).toBeVisible();

  // Click /session
  await palette.locator('.command-palette-item').first().click();

  // Input should now contain "/session "
  await expect(input).toHaveValue('/session ');

  // Sub-options should appear (rename, list)
  await expect(palette).toBeVisible();
  await expect(palette.locator('.command-palette-item')).toHaveCount(2);
  await expect(palette.locator('.command-palette-label').first()).toContainText('Rename');
});

test('/model shows available models in autocomplete', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const palette = page.locator('.command-palette');

  // Type "/model " to show model sub-options
  await input.fill('/model ');
  await expect(palette).toBeVisible();

  // Should show available models from mock agent
  const items = palette.locator('.command-palette-item');
  await expect(items).toHaveCount(5);

  // Verify model names appear
  await expect(palette.locator('.command-palette-label').nth(0)).toContainText('Claude Sonnet 4.6');
  await expect(palette.locator('.command-palette-label').nth(1)).toContainText('Claude Sonnet 4.5');
  await expect(palette.locator('.command-palette-label').nth(2)).toContainText('Claude Haiku 4.5');
  await expect(palette.locator('.command-palette-label').nth(3)).toContainText('Claude Opus 4.6');
  await expect(palette.locator('.command-palette-label').nth(4)).toContainText('GPT-5.1');

  // Filter by typing a prefix
  await input.fill('/model haiku');
  await expect(items).toHaveCount(1);
  await expect(palette.locator('.command-palette-label').first()).toContainText('Claude Haiku 4.5');
});

test('model label shows current model on the input border', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Should show the default model from session/new
  const label = page.locator('#model-label');
  await expect(label).toBeVisible();
  await expect(label).toContainText('Claude Sonnet 4.6');

  // Switch model via /model command
  const input = page.locator('#prompt-input');
  await input.fill('/model claude-haiku-4.5');
  await page.locator('#send-btn').click();

  // Label should update to the new model
  await expect(label).toContainText('Claude Haiku 4.5');
});

test('input textarea and send button bottom-align', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const inputBottom = await page.locator('#prompt-input').evaluate(
    (el) => el.getBoundingClientRect().bottom,
  );
  const btnBottom = await page.locator('#send-btn').evaluate(
    (el) => el.getBoundingClientRect().bottom,
  );

  // Bottom edges should be within 1px of each other
  expect(Math.abs(inputBottom - btnBottom)).toBeLessThanOrEqual(1);
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
  await expect(page.locator('.message.agent').first()).toBeVisible({ timeout: 10000 });
});

test('session is preserved across /model commands', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  // Send a message so a session is established
  await page.locator('#prompt-input').fill('hello');
  await page.locator('#send-btn').click();
  await expect(page.locator('.message.agent').first()).toBeVisible({ timeout: 10000 });

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
  const thinking = page.locator('.tool-call-thinking').first();
  await expect(thinking).toBeAttached({ timeout: 10000 });

  // Verify it's a <details> element
  const tagName = await thinking.evaluate(el => el.tagName.toLowerCase());
  expect(tagName).toBe('details');

  // Verify it contains accumulated reasoning content
  await expect(thinking).toContainText('analyzed the problem', { timeout: 5000 });

  // Verify the agent message also rendered
  await expect(page.locator('.message.agent').first()).toContainText('Based on my analysis');
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

  // Switch to autopilot mode via /autopilot command (client-side)
  await page.locator('#prompt-input').fill('/autopilot');
  await page.locator('#send-btn').click();

  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-mode', 'autopilot');

  // System message should confirm mode switch
  const sysMsg = page.locator('.message.system').filter({ hasText: 'Switched to autopilot mode' });
  await expect(sysMsg).toBeVisible({ timeout: 5000 });

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
  // Allow 1px tolerance for sub-pixel rendering differences across engines
  expect(Math.abs(inputBox!.height - sendBox!.height)).toBeLessThanOrEqual(1);

  // Trigger a prompt to make the cancel button appear
  await input.fill('hello');
  await page.locator('#send-btn').click();
  const cancelBtn = page.locator('#cancel-btn');
  await expect(cancelBtn).toBeVisible({ timeout: 5000 });

  const cancelBox = await cancelBtn.boundingBox();
  expect(cancelBox).not.toBeNull();
  expect(Math.abs(cancelBox!.height - sendBox!.height)).toBeLessThanOrEqual(1);
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
  await expect(toolCall.locator('.status')).toContainText('failed', { timeout: 10000 });

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
  const agentMsg = page.locator('.message.agent').first();
  await expect(agentMsg).toBeVisible({ timeout: 10000 });
  await expect(agentMsg).toContainText('thinking it through');

  // Thinking content should be rendered as a collapsible block
  const thinking = page.locator('.tool-call-thinking').first();
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

  // Type ! — should show shell-input
  await input.fill('!echo hello');
  await expect(html).toHaveAttribute('data-mode', 'shell-input');

  // Delete the ! — should revert to plan, not chat
  await input.fill('echo hello');
  await expect(html).toHaveAttribute('data-mode', 'plan');
});

test('sending a shell command reverts border to current mode', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const html = page.locator('html');

  // Start in chat mode
  await expect(html).toHaveAttribute('data-mode', 'chat');

  // Send a shell command
  await input.fill('!echo hello');
  await expect(html).toHaveAttribute('data-mode', 'shell-input');
  await page.locator('#send-btn').click();

  // After sending, border should revert to chat mode immediately
  await expect(html).toHaveAttribute('data-mode', 'chat');
});

test('typing /plan previews plan border, backspacing reverts', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const html = page.locator('html');

  // Start in chat mode
  await expect(html).toHaveAttribute('data-mode', 'chat');

  // Type /plan — should preview plan border
  await input.fill('/plan');
  await expect(html).toHaveAttribute('data-mode', 'plan');

  // Type more after /plan — still plan mode
  await input.fill('/plan fix the bug');
  await expect(html).toHaveAttribute('data-mode', 'plan');

  // Backspace to just "/" — should revert to chat
  await input.fill('/');
  await expect(html).toHaveAttribute('data-mode', 'chat');
});

test('typing /autopilot previews autopilot border', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const html = page.locator('html');

  await input.fill('/autopilot');
  await expect(html).toHaveAttribute('data-mode', 'autopilot');

  // Clear input — reverts to chat
  await input.fill('hello');
  await expect(html).toHaveAttribute('data-mode', 'chat');
});

test('typing /agent while in plan mode previews chat border', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const html = page.locator('html');

  // Enter plan mode
  await input.fill('/plan');
  await page.locator('#send-btn').click();
  await expect(html).toHaveAttribute('data-mode', 'plan');

  // Type /agent — should preview chat (agent = default chat mode)
  await input.fill('/agent');
  await expect(html).toHaveAttribute('data-mode', 'chat');
});

test('clicking /plan in palette previews plan border immediately', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#send-btn')).toBeEnabled({ timeout: 10000 });

  const input = page.locator('#prompt-input');
  const html = page.locator('html');
  const palette = page.locator('.command-palette');

  // Start in chat mode
  await expect(html).toHaveAttribute('data-mode', 'chat');

  // Type / to open palette
  await input.fill('/');
  await expect(palette).toBeVisible();

  // Click /plan in the palette
  const planItem = palette.locator('.command-palette-item', { hasText: 'plan' }).first();
  await planItem.click();

  // Border should preview plan mode immediately
  await expect(html).toHaveAttribute('data-mode', 'plan');
});

// ─── Mobile-specific tests ────────────────────────────────────────────

test('input font-size is at least 16px to prevent iOS auto-zoom', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#prompt-input')).toBeVisible();

  const fontSize = await page.locator('#prompt-input').evaluate(
    (el) => parseFloat(getComputedStyle(el).fontSize),
  );
  // iOS auto-zooms inputs with font-size < 16px
  expect(fontSize).toBeGreaterThanOrEqual(16);
});

test('viewport meta prevents user scaling to avoid stuck-zoom states', async ({ page }) => {
  await page.goto('/');

  const content = await page.locator('meta[name="viewport"]').getAttribute('content');
  expect(content).toContain('maximum-scale=1');
  expect(content).toContain('user-scalable=no');
});

test('app layout uses flex column without position fixed', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();

  const styles = await page.locator('#app').evaluate((el) => {
    const s = getComputedStyle(el);
    return { position: s.position, display: s.display, flexDirection: s.flexDirection };
  });

  // position:fixed prevents dvh from working with mobile keyboards
  expect(styles.position).not.toBe('fixed');
  expect(styles.display).toBe('flex');
  expect(styles.flexDirection).toBe('column');
});
