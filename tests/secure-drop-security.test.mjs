import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const [html, script] = await Promise.all([
  readFile(new URL('site/secure-drop.html', root), 'utf8'),
  readFile(new URL('site/secure-drop.js', root), 'utf8'),
]);

test('source intake fails closed at the research stage', () => {
  assert.match(html, /<fieldset id="intake-fields" disabled>/u);
  assert.match(html, /Source intake is not operational\./u);
  assert.match(script, /RESEARCH ONLY \/ INTAKE DISABLED/u);
  assert.doesNotMatch(script, /crypto\.subtle|RSA-OAEP|AES-GCM|getRandomValues/u);
});

test('source surface has no browser persistence or submission primitive', () => {
  assert.doesNotMatch(
    script,
    /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|cookie/u,
  );
  assert.doesNotMatch(script, /innerHTML|insertAdjacentHTML|document\.write/u);
});

test('document policy blocks active and network-capable subresources', () => {
  for (const directive of [
    "default-src 'none'",
    "connect-src 'none'",
    "img-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ]) {
    assert.ok(html.includes(directive), `missing CSP directive: ${directive}`);
  }
  assert.match(html, /<meta name="referrer" content="no-referrer"/u);
  assert.doesNotMatch(html, /https?:\/\//u);
});

test('dormant fields disable browser-assisted text services', () => {
  assert.match(html, /<form id="source-form" autocomplete="off"/u);
  assert.equal((html.match(/spellcheck="false"/gu) ?? []).length, 3);
  assert.doesNotMatch(html, /spellcheck="true"/u);
});
