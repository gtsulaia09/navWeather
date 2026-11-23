#!/usr/bin/env node
/**
 * Print this Cloudflare account's workers.dev subdomain (the part in https://<worker>.<subdomain>.workers.dev), so the
 * workflows can point the app at its sibling Workers — the reports feed and the basemap (ADR-020) — without a custom
 * domain. Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID (the same secrets as deploying).
 */
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account } = process.env;
if (!token || !account) {
  console.error('workers-subdomain: CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required');
  process.exit(2);
}
const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/subdomain`, { headers: { Authorization: `Bearer ${token}` } });
const body = await res.json().catch(() => null);
const sub = body?.result?.subdomain;
if (!res.ok || typeof sub !== 'string' || !/^[a-z0-9-]+$/.test(sub)) {
  console.error(`workers-subdomain: Cloudflare answered ${res.status}`);
  process.exit(1);
}
console.log(sub);
