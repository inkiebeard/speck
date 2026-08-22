import type { Page } from '@playwright/test';

/** Navigates to the shared harness and waits for `window.Speck`/`window.THREE`
 *  to be attached. Call at the top of every perf spec — also reused by
 *  tests/noise/ for the same reason (it's the one place that loads the
 *  built dist/index.js as a real ES module). */
export async function gotoHarness(page: Page): Promise<void> {
  await page.goto('/tests/perf/harness.html');
  await page.waitForFunction(() => (window as unknown as { __ready?: boolean }).__ready === true);
}
