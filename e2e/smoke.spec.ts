import { expect, test, type Request } from '@playwright/test';

/**
 * The app end to end (DEVELOPMENT_PLAN DP-2.6, gate G4): search → a road with its weather → a simulated drive →
 * live sharing (and its viewer) → a driver report while really driving. Same suite on localhost and on preview.
 *
 * Always checked (ADR-019): the app talks to nobody but its own origin (static data + the sharing/reports API) and
 * OpenFreeMap — routing, search and forecasts run on the device. E2E_STRICT=1 (localhost after `npm run data:osm`,
 * `data:roads`, `data:weather`; preview with its data) also requires our data files to be there.
 *
 * The basemap (OpenFreeMap style and tiles) is not loaded unless E2E_MAP=1: in headless Chrome every map frame
 * waits on a GPU process that has no display, and the page stalls for about a minute after the map appears. The
 * flows under test don't need the picture; the map itself is checked by eye and by its own unit tests.
 */

const STRICT = process.env.E2E_STRICT === '1';
/** The only other host the app may reach: the map background (OpenFreeMap, no limits). */
const ALLOWED_HOSTS = ['tiles.openfreemap.org'];
// Where the example road starts (Tbilisi, our geocoder's city point).
const TBILISI = { latitude: 41.6936, longitude: 44.8014, accuracy: 8 };

test('search → road with weather → simulated drive → live share → driver report', async ({ page, context }) => {
  const foreign: string[] = [];
  const watch = (r: Request) => {
    const u = new URL(r.url());
    if (u.protocol === 'data:' || u.protocol === 'blob:') return;
    const own = u.host === new URL(page.url() === 'about:blank' ? (process.env.BASE_URL ?? 'http://localhost:5173') : page.url()).host;
    if (!own && !ALLOWED_HOSTS.includes(u.host)) foreign.push(`${u.host}${u.pathname}`);
  };
  context.on('request', watch);
  if (process.env.E2E_MAP !== '1') await context.route(/tiles\.openfreemap\.org/, (r) => r.abort());
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation(TBILISI);

  await test.step('locate button shows a visible blue dot and activates follow mode (B-43, B-47)', async () => {
    await page.goto('/');
    const locate = page.getByRole('button', { name: 'Show my location' });
    await expect(locate).toBeVisible();
    await locate.click();
    await expect(locate).toHaveAttribute('aria-pressed', 'true');
    const dot = page.locator('.me-dot');
    await expect(dot).toBeVisible();
    const dotBox = await dot.boundingBox();
    expect(dotBox?.width ?? 0).toBeGreaterThanOrEqual(16);
    expect(dotBox?.height ?? 0).toBeGreaterThanOrEqual(16);
    const coreBg = await page.locator('.me-dot__core').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(coreBg).not.toBe('rgba(0, 0, 0, 0)');
  });

  await test.step('search answers on the device from our index files', async () => {
    const search = page.getByRole('combobox', { name: 'Search a place or address' });
    const answer = page.waitForResponse((r) => r.url().includes('/data/search/') && r.request().method() === 'GET');
    await search.fill('Kutaisi');
    expect((await answer).ok()).toBe(true);
    await expect(page.getByRole('option', { name: /Kutaisi/ }).first()).toBeVisible();
    await search.fill('');
    await page.keyboard.press('Escape');
  });

  await test.step('typing Tbilisi → Batumi ranks Batumi city first, draws route line above basemap, and shows weather (B-44, B-45, B-47)', async () => {
    await page.getByRole('button', { name: 'Directions' }).click();
    const from = page.getByRole('combobox', { name: 'From' });
    await from.fill('Tbilisi');
    await page.getByRole('option', { name: /Tbilisi/ }).first().click();
    const to = page.getByRole('combobox', { name: 'To' });
    await to.fill('Batumi');
    // Batumi city must rank first ahead of streets in Tbilisi (B-45).
    await expect(page.getByRole('option').first()).toContainText(/Batumi/);
    await expect(page.getByRole('option').first()).toContainText(/Georgia/);
    const roads = page.waitForResponse((r) => r.url().includes('/data/roads/'));
    const forecast = page.waitForResponse((r) => r.url().includes('/data/weather/'));
    // Submitting directly while suggestions are open must not be blocked by the dropdown (B-47).
    await page.locator('form button[type="submit"]').click();
    await expect(page.getByText(/\d{3}\s?km\b/).first()).toBeVisible();
    await expect(page.getByText(/\d+\s*h\s*\d+\s*min/).first()).toBeVisible();
    expect((await roads).ok()).toBe(true);
    const f = await forecast;
    if (STRICT) expect(f.status()).toBe(200);
    // The route line must be inserted above all basemap fills (B-44).
    await expect(page.locator('.map')).toHaveAttribute('data-route-visible', '1');
    // The weather at each place on the way, at the time we get there.
    await expect(page.getByText('ETA').first()).toBeVisible();
    if (f.ok()) {
      await expect(page.locator('.sheet').getByText(/-?\d+°/).first()).toBeVisible();
    }
  });

  await test.step('a simulated drive, shared live, seen by a viewer', async () => {
    await page.getByRole('button', { name: 'Simulate drive' }).click();
    await expect(page.getByRole('button', { name: 'Exit simulation' })).toBeVisible();
    await page.getByRole('button', { name: 'Share trip progress' }).click();
    await page.getByPlaceholder('Shown to people with the link').fill('E2E');
    const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/share') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create link' }).click();
    expect((await created).status()).toBe(201);
    // The link sits in a read-only field (labelled "Link") for copying.
    const linkBox = page.getByRole('textbox', { name: 'Link' });
    await expect(linkBox).toHaveValue(/\/live\/[A-Za-z0-9_-]{22}$/);
    const url = await linkBox.inputValue();

    const viewer = await context.newPage();
    await viewer.goto(url);
    await expect(viewer.getByText('E2E').first()).toBeVisible();
    await viewer.close();

    const stopped = page.waitForResponse((r) => /\/api\/v1\/share\/[A-Za-z0-9_-]+$/.test(r.url()) && r.request().method() === 'DELETE');
    await page.getByRole('dialog', { name: 'Share your live location' }).getByRole('button', { name: 'Stop sharing' }).click();
    expect((await stopped).ok()).toBe(true);
    await page.getByRole('button', { name: 'Exit simulation' }).click();
  });

  await test.step('a driver report while really driving', async () => {
    await page.getByRole('button', { name: 'Start', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Report' })).toBeVisible();
    await page.getByRole('button', { name: 'Report' }).click();
    const sent = page.waitForResponse((r) => r.url().endsWith('/api/v1/reports') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /Hazard on the road/ }).click();
    // 201 a new report; 200 when one is already there (a repeated run counts as a confirmation).
    expect([200, 201]).toContain((await sent).status());
    await expect(page.getByText(/hazard on the road reported/i)).toBeVisible();
  });

  expect(foreign, 'requests to anyone but our own origin and the map background').toEqual([]);
});

test('locate button shows a visible warning when geolocation permission is denied (B-47)', async ({ browser }) => {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    locale: 'en-GB',
    timezoneId: 'Asia/Tbilisi',
    permissions: [],
  });
  const page = await ctx.newPage();
  if (process.env.E2E_MAP !== '1') await ctx.route(/tiles\.openfreemap\.org/, (r) => r.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Show my location' }).click();
  await expect(page.locator('.notice')).toBeVisible();
  await expect(page.locator('.notice')).toContainText(/Location is blocked/i);
  await ctx.close();
});
