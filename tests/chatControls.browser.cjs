// PLAYWRIGHT_PATH may point to an existing local Playwright installation.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL });
  const output = process.env.BROWSER_TEST_OUTPUT || '/private/tmp/timsgym-interactions';
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(`${process.env.TEST_BASE_URL || 'http://127.0.0.1:5181'}/tests/chatControls.browser.html`);
      const input = page.getByRole('textbox', { name: 'Message the coach' });
      await input.waitFor({ state: 'visible' });
      await input.fill('slow');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      const interrupt = page.getByRole('button', { name: 'Interrupt response' });
      await interrupt.waitFor({ state: 'visible' });
      await page.waitForFunction(() => !document.querySelector('[aria-label="Interrupt response"]').disabled);
      await page.screenshot({ path: `${output}/chat-running-${viewport.width}.png` });
      await interrupt.click();
      await page.getByText('Stopped. No changes were made.', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.interactionFixture.interrupts), 1);
      await page.locator('button[title="Try this message again"]').click();
      await page.getByText('Your request is complete.', { exact: true }).waitFor();
      assert.deepEqual(await page.evaluate(() => window.interactionFixture.requests), ['slow', 'slow']);
      await input.fill('fail');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.locator('button[title="Try this message again"]').click();
      const confirmation = page.getByRole('alertdialog');
      await confirmation.waitFor();
      assert.deepEqual(await page.evaluate(() => window.interactionFixture.requests), ['slow', 'slow', 'fail']);
      await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
      await confirmation.waitFor({ state: 'hidden' });
      await page.locator('button[title="Try this message again"]').click();
      await confirmation.getByRole('button', { name: 'Try again', exact: true }).click();
      await page.waitForFunction(() => window.interactionFixture.requests.length === 4);
      await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Active Workout', exact: true }).click();
      const headers = page.locator('button[aria-controls^="workout-exercise-"]');
      assert.equal(await headers.count(), 3);
      assert.equal(await page.locator('button[aria-expanded="true"][aria-controls^="workout-exercise-"]').count(), 1);
      await page.locator('#workout-exercise-exercise-0 input[placeholder="0"]').first().fill('45');
      await headers.nth(1).click();
      assert.equal(await headers.nth(0).getAttribute('aria-expanded'), 'false');
      assert.equal(await headers.nth(1).getAttribute('aria-expanded'), 'true');
      await headers.nth(0).click();
      assert.equal(await page.locator('#workout-exercise-exercise-0 input[placeholder="0"]').first().inputValue(), '45');
      await page.getByRole('button', { name: 'Mark set 1 as completed', exact: true }).click();
      assert.match(await headers.nth(0).innerText(), /1\/3 sets complete/);
      await headers.nth(0).focus();
      await page.keyboard.press('Enter');
      assert.equal(await headers.nth(0).getAttribute('aria-expanded'), 'false');
      await page.screenshot({ path: `${output}/workout-collapsed-${viewport.width}.png`, fullPage: true });
      await headers.nth(1).click();
      await page.screenshot({ path: `${output}/workout-expanded-${viewport.width}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(errors, []);
      console.log(`PASS ${viewport.width}px: interrupt, safe retry, review-required retry, accordion, preserved edits, keyboard and overflow`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
