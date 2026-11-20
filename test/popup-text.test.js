// Checks the popup's text helpers (error wording, countdowns, money) without opening a window.
// The helpers live inside src/popup.html, so this pulls each named function out of the page and
// runs it on its own. Run with `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'popup.html'), 'utf8');
const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));

// Source of `function name(...) { ... }`, found by matching braces
function extract(name) {
  const start = script.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found in popup.html`);
  let depth = 0;
  for (let i = script.indexOf('{', start); i < script.length; i++) {
    if (script[i] === '{') depth++;
    else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
  }
  throw new Error(`function ${name} has no end`);
}

const ctx = vm.createContext({ Date, Intl, Math, Number, String, isFinite });
vm.runInContext(['friendlyError', 'formatReset', 'money', 'level', 'percent'].map(extract).join('\n'), ctx);
const { friendlyError, formatReset, money, percent } = ctx;

const claude = { name: 'Claude' };
const chatgpt = { name: 'ChatGPT' };

test('server errors read as a plain sentence, not a status code', () => {
  for (const raw of ['Claude API returned 529', 'Anthropic returned 500.', 'ChatGPT returned 502', 'Grok returned 503']) {
    const text = friendlyError(claude, { error: raw });
    assert.doesNotMatch(text, /\d{3}/, raw);
    assert.match(text, /having problems/, raw);
  }
});

test('a refused request (4xx) is not called a temporary problem', () => {
  for (const raw of ['Claude API returned 403', 'ChatGPT returned 404']) {
    assert.doesNotMatch(friendlyError(claude, { error: raw }), /having problems|Trying again soon/, raw);
  }
});

test('network codes read as a connection problem', () => {
  for (const raw of ['ETIMEDOUT', 'UND_ERR_SOCKET', 'socket hang up', 'connect EHOSTUNREACH 1.2.3.4:443', 'ENETUNREACH', 'getaddrinfo ENOTFOUND api.anthropic.com', 'fetch failed']) {
    assert.match(friendlyError(chatgpt, { error: raw }), /Can’t reach ChatGPT/, raw);
  }
});

test('existing messages keep their meaning', () => {
  assert.equal(friendlyError(claude, { error: 'x', needsLogin: true }), 'Signed out of Claude.');
  assert.match(friendlyError(claude, { error: 'Claude rate limited (429)' }), /slow down/);
  assert.match(friendlyError(claude, { error: 'Timeout' }), /didn’t answer in time/);
  assert.match(friendlyError(chatgpt, { error: 'UND_ERR_CONNECT_TIMEOUT' }), /didn’t answer in time/);
  assert.match(friendlyError(chatgpt, { error: 'UND_ERR_HEADERS_TIMEOUT' }), /didn’t answer in time/);
  assert.equal(friendlyError(chatgpt, { error: 'ChatGPT sent an answer AI Tray could not read.' }), 'ChatGPT sent an answer AI Tray could not read.');
  assert.equal(friendlyError(claude, {}), 'Something went wrong.');
});

test('the last minute before a reset does not say "0m"', () => {
  assert.equal(formatReset(new Date(Date.now() + 30000).toISOString()), 'resets in under a minute');
  assert.equal(formatReset(new Date(Date.now() + 5 * 60000 + 5000).toISOString()), 'resets in 5m');
  assert.equal(formatReset(new Date(Date.now() + (2 * 60 + 29) * 60000 + 5000).toISOString()), 'resets in 2h 29m');
  assert.equal(formatReset(new Date(Date.now() - 1000).toISOString()), 'resetting');
});

test('money has thousands separators and its own currency', () => {
  assert.equal(money(12345.67, 'USD'), '$12,345.67');
  assert.equal(money(500, 'USD', 0), '$500');
  assert.equal(money(12.4), '$12.40');
  assert.equal(money(12.4, 'EUR'), '€12.40');
  assert.equal(money(12.4, 'not-a-currency'), '$12.40');
});

test('a missing usage number shows as 0%, never NaN%', () => {
  assert.equal(percent(undefined), 0);
  assert.equal(percent(null), 0);
  assert.equal(percent('41.6'), 42);
  assert.equal(percent(140), 100);
  assert.equal(percent(-3), 0);
});
