import { test, expect, Page } from '@playwright/test';

// E2E for the `sema workflow view` dashboard rendering a real workflow journal
// (the committed content-pipeline run: 4 phases, 6 agents, 3 checkpoints, success).
// Verifies the AlpineJS tree actually renders the frozen journal in a browser.

async function open(page: Page) {
  await page.goto('/', { waitUntil: 'networkidle' });
  // The tree is populated by fetch()+Alpine after load — wait for a phase row.
  await page.waitForSelector('[data-testid="phase"]', { timeout: 15000 });
}

test('renders the run header from the journal', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('wf-name')).toHaveText('content-pipeline');
  await expect(page.getByTestId('status-pill')).toHaveText('success');
  await expect(page.getByTestId('count-phases')).toHaveText('4');
  await expect(page.getByTestId('count-agents')).toHaveText('6');
  await expect(page.getByTestId('count-checkpoints')).toHaveText('3');
});

test('renders the phase tree in order', async ({ page }) => {
  await open(page);
  const names = page.getByTestId('phase-name');
  await expect(names).toHaveCount(4);
  await expect(names).toHaveText(['Topics', 'Write', 'Verify', 'Publish']);
});

test('renders the 6 fanned-out agent rows, all completed (not running)', async ({ page }) => {
  await open(page);
  const agents = page.getByTestId('agent-row');
  await expect(agents).toHaveCount(6);
  // Every agent merged started->result, so none is still 'running'.
  await expect(page.locator('[data-testid="agent-row"][data-status="running"]')).toHaveCount(0);
  // The fan-out leaves carry the topic names.
  await expect(page.getByTestId('agent-name').first()).toHaveText('tail-call optimization');
});

test('expanding an agent row reveals its output (expand-to-see-I/O)', async ({ page }) => {
  await open(page);
  const firstAgent = page.getByTestId('agent-row').first();
  const disclosure = page.getByTestId('disclosure').first();
  await expect(disclosure).toBeHidden();
  await firstAgent.click();
  await expect(disclosure).toBeVisible();
  await expect(disclosure).not.toHaveText(''); // the opaque output digest
});
