// Claude API spend this calendar month (UTC, as Anthropic bills), read with an Admin API key
// through the Usage and Cost Analytics API. The key is stored encrypted by main.js and passed in.
//
// Anthropic refreshes this data within about 4 hours (up to 24), so the card says how current
// it is. There is no API for remaining prepaid credit, so spend is shown against a budget.

const { Anthropic } = require('@anthropic-ai/sdk');

function monthBounds(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end, minutes: Math.round((end - start) / 60000) };
}

function money(dollars) {
  return dollars >= 1000 ? `$${Math.round(dollars).toLocaleString('en-US')}` : `$${dollars.toFixed(2)}`;
}

// An admin key can manage the whole organization (keys, members, workspaces), and Console admin
// keys can't be scoped down. So the client only ever gets this fetch, which refuses everything
// except the one read-only request AI Tray needs: GET the cost report from api.anthropic.com.
const ALLOWED_ORIGIN = 'https://api.anthropic.com';
const ALLOWED_PATH = '/v1/organizations/analytics/cost';
function readOnlyFetch(input, init = {}) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
  if (method !== 'GET' || url.origin !== ALLOWED_ORIGIN || url.pathname !== ALLOWED_PATH) {
    return Promise.reject(new Error(`Blocked: AI Tray only reads spend with the admin key (${method} ${url.origin}${url.pathname})`));
  }
  return fetch(input, init);
}

// Total spend (USD) from `start` (default: the start of this month) to now, plus how current
// Anthropic's numbers are
async function monthSpend(key, start = monthBounds().start) {
  // The API rounds the range down to the hour, so in the first hour of a month there's nothing to ask for yet
  if (Date.now() - start < 3600e3) return { dollars: 0, refreshedAt: null };
  // baseURL is fixed so an ANTHROPIC_BASE_URL set on the PC can't redirect the key elsewhere
  const client = new Anthropic({ apiKey: key, baseURL: ALLOWED_ORIGIN, maxRetries: 1, timeout: 20000, fetch: readOnlyFetch });
  // No group_by and no time buckets: one row totalling the month so far
  let page = await client.beta.organization.analytics.cost.list({ starting_at: start.toISOString() });
  const refreshedAt = page.data_refreshed_at;
  let cents = 0;
  for (;;) {
    for (const row of page.data) cents += parseFloat(row.cost.amount) || 0;
    if (!page.hasNextPage()) break;
    page = await page.getNextPage();
  }
  return { dollars: cents / 100, refreshedAt };
}

// Errors the popup shows as one plain sentence. `badKey` means the key itself won't work.
function describeError(e) {
  if (e instanceof Anthropic.AuthenticationError) return { error: 'Anthropic rejected the admin key.', badKey: true };
  if (e instanceof Anthropic.PermissionDeniedError) return { error: 'This key can’t read spend. It needs to be an admin key.', badKey: true };
  if (e instanceof Anthropic.NotFoundError) return { error: 'Anthropic’s spend report isn’t available for this account.' };
  if (e instanceof Anthropic.RateLimitError) return { error: 'Claude API rate limited (429).' };
  if (e instanceof Anthropic.APIConnectionError) return { error: 'Connection error (network).' };
  if (e instanceof Anthropic.APIError) return { error: `Anthropic returned ${e.status || 'an error'}.` };
  return { error: e.message || 'Something went wrong.' };
}

async function fetchUsage({ claudeApiKey, claudeApiBudget } = {}) {
  if (!claudeApiKey) return { error: 'No admin key saved.', needsKey: true };
  const budget = claudeApiBudget > 0 ? claudeApiBudget : 100;
  try {
    const { dollars, refreshedAt } = await monthSpend(claudeApiKey);
    const { end, minutes } = monthBounds();
    return {
      meters: [{
        key: 'month',
        label: 'This month',
        alertLabel: 'Claude API spend',
        valueText: `${money(dollars)} of ${money(budget).replace(/\.00$/, '')}`,
        utilization: dollars / budget * 100,
        resets_at: end.toISOString(),
        minutes,
      }],
      asOf: refreshedAt,
    };
  } catch (e) {
    return describeError(e);
  }
}

// Used when the key is first entered, so a wrong key is caught before it's saved. Asks about the
// last two hours, which is always a valid range (the month-to-date one isn't in a month's first hour).
async function checkKey(key) {
  try {
    await monthSpend(key, new Date(Date.now() - 2 * 3600e3));
    return { ok: true };
  } catch (e) {
    return { ok: false, status: e.status, ...describeError(e) };
  }
}

module.exports = { fetchUsage, checkKey, readOnlyFetch };
