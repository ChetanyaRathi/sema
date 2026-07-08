import { test, expect, Page } from '@playwright/test';

// E2E for the `sema workflow view` dashboard — the full variant-5b three-pane
// layout — rendering the rich `audit-auth` fixture journal (4 phases, 4 agents
// with models + per-agent budget, tool calls, checkpoints; run still live).

async function open(page: Page) {
  await page.goto('/?run=audit-auth', { waitUntil: 'networkidle' });
  await page.getByTestId('phase').first().waitFor({ timeout: 15000 });
}

test('header + rollup: name, live status, phases/agents/tokens/cost', async ({ page }) => {
  await open(page);
  await expect(page.getByTestId('wfname')).toHaveText('audit-auth');
  await expect(page.getByTestId('status-pill')).toHaveText('running'); // no run.ended → live
  await expect(page.getByTestId('r-phases')).toHaveText('4');
  await expect(page.getByTestId('r-agents')).toHaveText('4');
  await expect(page.getByTestId('r-tokens')).toHaveText('9.4k'); // 4000+3740+1660
  await expect(page.getByTestId('r-cost')).toContainText('0.0058'); // 0.0041 + 0.0017 (auditor_2 unpriced)
  // meta strip is populated from run.started
  await expect(page.getByTestId('m-runid')).toHaveText('wf_audit_auth_8f3a21');
  await expect(page.getByTestId('m-code')).toHaveText('a3f1c09e');
});

test('left pane: the phase ledger renders all four phases in order', async ({ page }) => {
  await open(page);
  const phases = page.getByTestId('phase');
  await expect(phases).toHaveCount(4);
  for (const name of ['inventory', 'audit', 'verify', 'report']) {
    await expect(page.getByTestId('phase').and(page.locator(`[data-phase-name="${name}"]`))).toHaveCount(1);
  }
});

test('right pane: the raw event stream renders one row per journal event', async ({ page }) => {
  await open(page);
  // 24 events in the fixture → 24 stream rows; the cursor shows the last seq.
  await expect(page.getByTestId('ev-row')).toHaveCount(24);
  await expect(page.getByTestId('stream-cursor')).toHaveText('23');
});

test('center pane: selecting the audit phase shows its 3 agents with model + columns', async ({ page }) => {
  await open(page);
  await page.getByTestId('phase').and(page.locator('[data-phase-name="audit"]')).click();
  const agents = page.getByTestId('agent-row');
  await expect(agents).toHaveCount(3);
  // model column is rendered (full model id, per the prototype)
  await expect(page.getByTestId('agent-model').first()).toContainText('claude-haiku');
  // one auditor failed → a failed status row exists
  await expect(page.getByTestId('agent-row').and(page.locator('[data-status="failed"]'))).toHaveCount(1);
});

test('drill-in details: Prompt / Tool calls / Output digest sections', async ({ page }) => {
  await open(page);
  await page.getByTestId('phase').and(page.locator('[data-phase-name="audit"]')).click();
  await page.getByTestId('agent-row').first().click();
  const drill = page.getByTestId('drill');
  await expect(drill).toBeVisible();
  await expect(drill).toContainText('Prompt');
  await expect(drill).toContainText('Tool calls');
  await expect(drill).toContainText('Output');
});

test('status pill is on-brand (rounded, brand pill radius)', async ({ page }) => {
  await open(page);
  const radius = await page
    .getByTestId('status-pill')
    .evaluate((el) => getComputedStyle(el).borderRadius);
  expect(parseFloat(radius)).toBeGreaterThanOrEqual(12); // brand "pill" = 20px, not square
});

test('event stream: finished agents do not pulse; only a live agent does', async ({ page }) => {
  await open(page);
  // auditor_1 finished (has agent.result) → its agent.started stream glyph must NOT pulse.
  const finishedGlyph = page
    .getByTestId('ev-row')
    .and(page.locator('[data-ev-agent="auditor_1"]'))
    .getByTestId('ev-glyph')
    .first();
  await expect(finishedGlyph).not.toHaveClass(/pulse/);
  // reporter_1 is still running (no agent.result) → its glyph DOES pulse.
  const liveGlyph = page
    .getByTestId('ev-row')
    .and(page.locator('[data-ev-agent="reporter_1"]'))
    .getByTestId('ev-glyph')
    .first();
  await expect(liveGlyph).toHaveClass(/pulse/);
});

test('phase ledger: checkpoint-only phase shows ◇N, not a misleading 0/0', async ({ page }) => {
  await open(page);
  // verify is a pure-checkpoint phase (1 checkpoint, 0 agents) → "◇1", never "0/0".
  const verifyCount = page
    .getByTestId('phase')
    .and(page.locator('[data-phase-name="verify"]'))
    .getByTestId('phase-count');
  await expect(verifyCount).toHaveText('◇1');
  await expect(verifyCount).not.toHaveText('0/0');
  // audit has agents → still the done/total form.
  await expect(
    page.getByTestId('phase').and(page.locator('[data-phase-name="audit"]')).getByTestId('phase-count')
  ).toHaveText('3/3');
});

test('event stream → click jumps to the agent in the detail pane', async ({ page }) => {
  await open(page);
  // The agent.result for auditor_2 (an event-stream row) jumps to auditor_2.
  const row = page.getByTestId('ev-row').and(page.locator('[data-ev-agent="auditor_2"]')).first();
  await row.click();
  await expect(
    page.getByTestId('agent-row').and(page.locator('[data-agent="auditor_2"][data-selected="true"]'))
  ).toHaveCount(1);
});

// all-phases-upfront (S5): a run that declares 4 phases (run.started.phases) but has
// only started 2 shows the whole plan — Inventory done, Audit running, Verify+Report
// pending (dimmed, NOT a misleading ✓). Order preserved.
test('phase ledger shows ALL declared phases, un-started ones pending', async ({ page }) => {
  await page.goto('/?run=audit-pending', { waitUntil: 'networkidle' });
  await page.getByTestId('phase').first().waitFor({ timeout: 15000 });

  const phases = page.getByTestId('phase');
  await expect(phases).toHaveCount(4); // all declared phases up front
  // order matches the declared plan
  await expect(phases.nth(0)).toHaveAttribute('data-phase-name', 'Inventory');
  await expect(phases.nth(1)).toHaveAttribute('data-phase-name', 'Audit');
  await expect(phases.nth(2)).toHaveAttribute('data-phase-name', 'Verify');
  await expect(phases.nth(3)).toHaveAttribute('data-phase-name', 'Report');

  // status spread: done / running / pending / pending
  await expect(phases.nth(0)).toHaveAttribute('data-status', 'done');
  await expect(phases.nth(1)).toHaveAttribute('data-status', 'running');
  await expect(page.getByTestId('phase').and(page.locator('[data-status="pending"]'))).toHaveCount(2);

  // a pending row shows the pending glyph (○), never the done ✓
  const verify = page.getByTestId('phase').and(page.locator('[data-phase-name="Verify"]'));
  await expect(verify.getByTestId('phase-glyph')).toHaveText('○');

  // header rollup counts only STARTED phases (2), while the ledger shows all 4
  await expect(page.getByTestId('r-phases')).toHaveText('2');
});
