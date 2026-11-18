import { expect, test, type Page } from '@playwright/test';

/**
 * Phones and tablets (emulated in Chrome: viewport, touch, device pixel ratio — not a real device; see README
 * "Test on a phone"). Each check pins a defect found by the 2026-11 mobile audit so it can't come back:
 *   - no sideways overflow at any common size;
 *   - the bottom sheet's full-width grab handle stole taps from header controls (a place card's ✕);
 *   - on landscape phones the plan panel's header was taller than the panel: Start was cut off, unreachable;
 *     on a 320×568 phone the default sheet was 3 px shorter than its header;
 *   - Settings' `.chip` rules leaked into the share dialog once Settings had been opened (44 px → 36 px);
 *   - dialogs focused their text field on open, throwing the keyboard over them on touch screens.
 * The basemap is not loaded (as in smoke.spec.ts: headless Chrome stalls on map frames).
 */

const TBILISI = { latitude: 41.6936, longitude: 44.8014, accuracy: 8 };

test.beforeEach(async ({ context }) => {
  await context.route(/tiles\.openfreemap\.org/, (r) => r.abort());
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(TBILISI);
});

/** Elements of the app that stick out of the viewport sideways (scrolling strips excepted). */
function sidewaysOverflow(page: Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const out: string[] = [];
    if (document.documentElement.scrollWidth > vw + 1) out.push(`page ${document.documentElement.scrollWidth}px wide`);
    for (const el of document.querySelectorAll<HTMLElement>('.app *')) {
      if (el.closest('.maplibregl-canvas-container, .maplibregl-marker, svg')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      // Inside a sideways scroller (chips, hourly strip): that is meant to scroll.
      let scroller = false;
      for (let p = el.parentElement; p && !p.classList.contains('app'); p = p.parentElement) {
        if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowX)) scroller = true;
      }
      if (!scroller) out.push(`${el.tagName.toLowerCase()}.${el.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return out;
  });
}

/** Sheets whose content hangs out of them (not scrollable): the controls down there can't be reached. */
function sheetSpill(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.sheet')]
      .filter((sh) => getComputedStyle(sh).overflowY === 'visible' && sh.scrollHeight > sh.clientHeight + 1)
      .map((sh) => `${sh.className}: ${sh.scrollHeight}px of content in ${sh.clientHeight}px`),
  );
}

/** Controls in sheet headers whose top edge is covered by something else (the grab handle, before the fix). */
function coveredHeaderControls(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.sheet__header button, .sheet__header a[href]')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) return false;
        const at = document.elementFromPoint(r.left + r.width / 2, r.top + 4);
        return at !== null && !el.contains(at);
      })
      .map((el) => el.getAttribute('aria-label') ?? el.textContent?.trim()),
  );
}

async function planExampleRoute(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Try Tbilisi → Batumi' }).click();
  await expect(page.getByText(/\d{3}\s?km\b/).first()).toBeVisible();
}

for (const size of [
  { width: 320, height: 568 },
  { width: 375, height: 667 },
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 844, height: 390 },
]) {
  test.describe(`${size.width}×${size.height}`, () => {
    test.use({ viewport: size, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

    test('nothing sticks out sideways: explore, a place, a road', async ({ page }) => {
      await page.goto('/');
      const search = page.getByRole('combobox', { name: 'Search a place or address' });
      await expect(search).toBeVisible();
      expect(await sidewaysOverflow(page)).toEqual([]);
      await search.fill('Kutaisi');
      await page.getByRole('option', { name: /Kutaisi/ }).first().click();
      await expect(page.getByRole('button', { name: 'Close' }).first()).toBeVisible();
      expect(await sidewaysOverflow(page)).toEqual([]);
      await page.getByRole('button', { name: 'Close' }).first().tap();
      await page.getByRole('button', { name: 'Try Tbilisi → Batumi' }).click();
      await expect(page.getByText(/\d{3}\s?km\b/).first()).toBeVisible();
      expect(await sidewaysOverflow(page)).toEqual([]);
      expect(await sheetSpill(page)).toEqual([]);
    });
  });
}

test.describe('phone, portrait', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test("a place card's ✕ closes it, even tapped near its top edge (under the grab handle's reach)", async ({ page }) => {
    await page.goto('/');
    await page.getByRole('combobox', { name: 'Search a place or address' }).fill('Kutaisi');
    await page.getByRole('option', { name: /Kutaisi/ }).first().click();
    const close = page.locator('.phead__close');
    await expect(close).toBeVisible();
    expect(await coveredHeaderControls(page)).toEqual([]);
    const box = (await close.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + 6);
    await expect(close).toHaveCount(0);
  });

  test('the drive sheet: pause, speed and exit are not under the grab handle', async ({ page }) => {
    await planExampleRoute(page);
    await page.getByRole('button', { name: 'Simulate drive' }).click();
    await expect(page.getByRole('button', { name: 'Exit simulation' })).toBeVisible();
    // Paused, the sheet stops changing height under the moving car (rows come and go), so the tap lands where measured.
    await page.getByRole('button', { name: 'Pause' }).tap();
    await expect(page.getByRole('button', { name: 'Pause' })).toHaveCount(0);
    expect(await coveredHeaderControls(page)).toEqual([]);
    const exit = (await page.getByRole('button', { name: 'Exit simulation' }).boundingBox())!;
    await page.touchscreen.tap(exit.x + exit.width / 2, exit.y + 4);
    await expect(page.getByRole('button', { name: 'Simulate drive' })).toBeVisible();
  });

  test('share dialog: no keyboard thrown up on open; its duration chips keep 44 px after Settings was opened', async ({ page }) => {
    await planExampleRoute(page);
    // Opening Settings loads its stylesheet — which used to restyle the share dialog's chips.
    await page.getByRole('button', { name: 'Settings' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Simulate drive' }).click();
    await page.getByRole('button', { name: 'Share trip progress' }).click();
    const dialog = page.getByRole('dialog', { name: 'Share your live location' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toBeFocused();
    await expect(page.getByPlaceholder('Shown to people with the link')).not.toBeFocused();
    for (const chip of await dialog.locator('.share__durations .chip').all()) {
      expect((await chip.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Exit simulation' }).click();
  });
});

test.describe('phone, departure chart', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('a finger sliding along the ~10 px bars shows each time and picks the one it stops on', async ({ page, context }) => {
    await planExampleRoute(page);
    await page.locator('.sheet__handle').first().tap();
    const chart = page.locator('.depart__chart');
    // The chart only appears when leaving later changes the weather on the way (today's forecast decides).
    if (!(await chart.count())) test.skip(true, 'no departure chart: the forecast is the same for every departure today');
    await chart.scrollIntoViewIfNeeded();
    const bars = page.locator('.depart__bar');
    const from = (await bars.nth(2).boundingBox())!;
    const to = (await bars.nth(12).boundingBox())!;
    const y = from.y + from.height / 2;
    const cdp = await context.newCDPSession(page);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await touch('touchStart', from.x + from.width / 2);
    for (let x = from.x; x <= to.x + to.width / 2; x += 8) await touch('touchMove', x);
    await expect(page.locator('.depart__readout')).toContainText('Leave at');
    await touch('touchEnd');
    await expect(bars.nth(12)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.depart__readout')).toHaveCount(0);
    // A plain tap afterwards still picks its own bar.
    const five = (await bars.nth(5).boundingBox())!;
    await page.touchscreen.tap(five.x + five.width / 2, five.y + five.height / 2);
    await expect(bars.nth(5)).toHaveAttribute('aria-pressed', 'true');
  });
});

test.describe('phone, landscape', () => {
  test.use({ viewport: { width: 568, height: 320 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });

  test('the plan panel scrolls as one piece, so Start can be reached and tapped', async ({ page }) => {
    await planExampleRoute(page);
    const sheet = page.locator('.sheet');
    const overflow = await sheet.evaluate((el) => ({ style: getComputedStyle(el).overflowY, bottom: el.getBoundingClientRect().bottom }));
    expect(overflow.style).toBe('auto');
    expect(overflow.bottom).toBeLessThanOrEqual(320);
    const start = page.getByRole('button', { name: 'Start', exact: true });
    await start.scrollIntoViewIfNeeded();
    await expect(start).toBeInViewport({ ratio: 1 });
    // Inside the panel, not hanging below it.
    const s = (await start.boundingBox())!;
    expect(s.y + s.height).toBeLessThanOrEqual(overflow.bottom + 1);
  });
});

/**
 * iPhone geometry, from the iOS Simulator (iPhone 18 Pro, Safari, 2026-11-19): in landscape Safari leaves the page
 * 874×292 CSS px with the Dynamic Island's safe area at the side (62 px), the home indicator's at the bottom (20 px).
 * Chrome stands in for WebKit here, with the same viewport and safe areas (DevTools' safe-area override).
 */
async function iPhoneSafeAreas(page: Page, insets: { top: number; right: number; bottom: number; left: number }) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride' as never, { insets } as never);
}

/** The floating map buttons: each fully on screen and under nothing else. */
function floatingButtonProblems(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const b of document.querySelectorAll<HTMLElement>('.voice button')) {
      const r = b.getBoundingClientRect();
      const name = b.getAttribute('aria-label');
      if (getComputedStyle(b).visibility === 'hidden' || getComputedStyle(b.closest('.voice')!).visibility === 'hidden') out.push(`${name}: hidden`);
      if (r.top < 0 || r.left < 0 || r.bottom > innerHeight || r.right > innerWidth) out.push(`${name}: off screen`);
      for (const [x, y] of [[r.left + r.width / 2, r.top + 4], [r.left + r.width / 2, r.top + r.height / 2]]) {
        const at = document.elementFromPoint(x, y);
        if (at && !b.contains(at)) out.push(`${name}: under ${at.className}`);
      }
    }
    return [...new Set(out)];
  });
}

test.describe('iPhone Safari, landscape (notch at the side)', () => {
  test.use({ viewport: { width: 874, height: 292 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('the side panel is recognised as one: map buttons stay, and none hides under the turn banner while driving', async ({ page }) => {
    await iPhoneSafeAreas(page, { top: 0, right: 62, bottom: 20, left: 62 });
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Show my location' })).toBeVisible();
    // Was: panel 70 px from the edge → taken for a bottom sheet "covering" the map → every map button hidden.
    expect(await floatingButtonProblems(page)).toEqual([]);
    const insetLeft = await page.evaluate(() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--inset-left')));
    expect(insetLeft).toBeGreaterThan(300);

    await page.getByRole('button', { name: 'Try Tbilisi → Batumi' }).click();
    await expect(page.getByText(/\d{3}\s?km\b/).first()).toBeVisible();
    expect(await floatingButtonProblems(page)).toEqual([]);
    await page.getByRole('button', { name: 'Simulate drive' }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: 'Simulate drive' }).tap();
    await expect(page.getByRole('button', { name: 'Exit simulation' })).toBeVisible();
    await page.getByRole('button', { name: 'Pause' }).tap();
    // Was: a column of 4 buttons under a 292 px viewport — Report sat behind the turn banner.
    expect(await floatingButtonProblems(page)).toEqual([]);
  });
});

test.describe('iPhone home-screen app, portrait (status bar and home indicator)', () => {
  test.use({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('nothing sits under the status bar or the home indicator', async ({ page }) => {
    await iPhoneSafeAreas(page, { top: 62, right: 0, bottom: 34, left: 0 });
    await planExampleRoute(page);
    const search = (await page.locator('.search').boundingBox())!;
    expect(search.y).toBeGreaterThanOrEqual(62);
    const start = (await page.getByRole('button', { name: 'Start', exact: true }).boundingBox())!;
    expect(start.y + start.height).toBeLessThanOrEqual(874 - 34);
    // The default sheet covers most of this map, and the floating buttons step aside by design; collapsed, they show.
    await page.locator('.sheet__handle').tap(); // → expanded
    await page.locator('.sheet__handle').tap(); // → compact
    await expect(page.locator('.sheet')).toHaveClass(/sheet--compact/);
    await expect(page.getByRole('button', { name: 'Show my location' })).toBeVisible();
    expect(await floatingButtonProblems(page)).toEqual([]);
  });
});

test.describe('iPhone Safari, portrait', () => {
  test.use({ viewport: { width: 402, height: 714 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });

  test('a long press selects no app text (it took over sheet drags); fields stay editable; no hard ring in search', async ({ page }) => {
    await page.goto('/');
    const search = page.getByRole('combobox', { name: 'Search a place or address' });
    await search.tap();
    await expect(search).toBeFocused();
    // Safari treats any focused text field as :focus-visible; the global ring drew a rectangle inside the card.
    expect(await search.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe('none');
    await search.fill('Kutaisi');
    await expect(search).toHaveValue('Kutaisi');
    const styles = await page.evaluate(() => {
      const app = getComputedStyle(document.querySelector('.app')!);
      const field = getComputedStyle(document.querySelector('.app input')!);
      return { app: app.userSelect || app.webkitUserSelect, field: field.userSelect || field.webkitUserSelect };
    });
    expect(styles).toEqual({ app: 'none', field: 'text' });
  });
});
