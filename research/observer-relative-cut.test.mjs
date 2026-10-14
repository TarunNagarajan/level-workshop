import assert from 'node:assert/strict';
import test from 'node:test';
import { certifyObserverCut, compareObserverBoundary } from './observer-relative-cut.mjs';

const capture = (asset = { path: '/cover.webp', status: 200, contentType: 'image/webp', hash: 'same' }) => ({
  textHash: 'text', accessibilityHash: 'a11y', screenshotPixelHash: 'pixels', coverPixelHash: 'cover', exifHash: null,
  network: [{ path: '/index.html', status: 200, contentType: 'text/html', hash: 'html' }, asset].filter(Boolean),
});

test('a world-dependent resource path is an exposure witness, not an invalid capture', () => {
  const result = certifyObserverCut(capture(), capture({ path: '/other.webp', status: 200, contentType: 'image/webp', hash: 'same' }), ['resourceRequests']);
  assert.equal(result.status, 'exposed');
  assert.deepEqual(result.differingRequests, ['/cover.webp', '/other.webp']);
  assert.deepEqual(result.differingResources, ['/cover.webp', '/other.webp']);
});

test('status, response bytes, and decoded pixels remain separate author claims', () => {
  const left = capture();
  const statusChange = compareObserverBoundary(left, capture({ path: '/cover.webp', status: 404, contentType: 'image/webp', hash: 'same' }));
  assert.deepEqual(statusChange.differingRequests, ['/cover.webp']);
  assert.equal(statusChange.channels.downloadedBytes, false);
  const right = capture({ path: '/cover.webp', status: 200, contentType: 'image/webp', hash: 'other' });
  assert.equal(certifyObserverCut(left, right, ['renderedPixels']).status, 'equivalent');
  assert.equal(certifyObserverCut(left, right, ['downloadedBytes']).status, 'exposed');
});

test('a repeat request changes the download boundary even if its URL already existed', () => {
  const left = capture();
  const right = capture();
  right.network.push({ ...right.network.at(-1) });
  const result = compareObserverBoundary(left, right);
  assert.deepEqual(result.differingResources, ['/cover.webp']);
  assert.deepEqual(result.differingRequests, ['/cover.webp']);
});

test('an action response can reveal a fact while GET resources stay equal', () => {
  const left = { ...capture(), actionPayloadHash: 'card E' };
  const right = { ...capture(), actionPayloadHash: 'card N' };
  const result = compareObserverBoundary(left, right);
  assert.equal(result.channels.actionPayload, false);
  assert.equal(result.channels.downloadedBytes, true);
  assert.deepEqual(result.differingResources, []);
});
