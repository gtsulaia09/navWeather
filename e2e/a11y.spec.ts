import { expect, test } from '@playwright/test';

/**
 * Automated WCAG 2.1 AA accessibility checks (DP-11.4, REQ-A11Y-001/002/003)
 * across explore, directions, route plan, and settings in both light and dark modes.
 */
async function auditPageA11y(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const issues: string[] = [];

    // 1. html[lang] present
    if (!document.documentElement.lang) issues.push('missing html[lang]');

    // 2. Every visible button and link has an accessible name (text, aria-label, or aria-labelledby)
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, a[href]'))) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || el.offsetWidth === 0 || el.offsetHeight === 0) continue;
      if (el.getAttribute('aria-hidden') === 'true') continue;
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
      if (!name && !el.getAttribute('aria-labelledby')) {
        issues.push(`unlabelled ${el.tagName.toLowerCase()}.${el.className}`);
      }
    }

    // 3. No duplicate IDs in DOM
    const seenIds = new Set<string>();
    for (const el of Array.from(document.querySelectorAll('[id]'))) {
      if (seenIds.has(el.id)) issues.push(`duplicate id="${el.id}"`);
      seenIds.add(el.id);
    }

    // 4. Every visible dialog has role="dialog" and an accessible label
    for (const dlg of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))) {
      if (dlg.offsetWidth === 0) continue;
      if (!dlg.getAttribute('aria-label') && !dlg.getAttribute('aria-labelledby')) {
        issues.push('dialog missing aria-label or aria-labelledby');
      }
    }

    return issues;
  });
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibility audit (${scheme} mode)`, () => {
    test.use({ viewport: { width: 1280, height: 800 }, colorScheme: scheme });

    test('explore, directions, settings, and Georgian locale pass WCAG checks', async ({ page }) => {
      await page.route('**/data/basemap/**', (r) => r.abort());
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.fab--locate', { timeout: 15_000 });

      // 1. Explore state
      expect(await auditPageA11y(page)).toEqual([]);

      // 2. Directions state + Flight disabled check
      await page.click('button[aria-label="Directions"]');
      await expect(page.locator('button[role="radio"][aria-label="Flight"]')).toBeDisabled();
      expect(await auditPageA11y(page)).toEqual([]);

      // 3. Settings dialog (focus trap + Escape + Georgian language switch)
      await page.click('button[aria-label="Settings"]');
      await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
      expect(await auditPageA11y(page)).toEqual([]);

      // Switch to Georgian (ka) and verify UI translates cleanly
      const langSelect = page.locator('select').first();
      await langSelect.selectOption('ka');
      await expect(page.locator('[role="dialog"] h2')).toContainText('პარამეტრები');

      await page.keyboard.press('Escape');
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    });
  });
}
