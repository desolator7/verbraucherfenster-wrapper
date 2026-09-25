import test from 'node:test';
import assert from 'node:assert/strict';
import { createLatestRequest, groupPublications } from '../web/map-state.js';

const feature = (id, coordinates = [8.5, 50.5], name = `Betrieb ${id}`) => ({
  type: 'Feature', geometry: { type: 'Point', coordinates },
  properties: { id, name, sourceUrl: `https://example.test/${id}` },
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};

test('tooltips keep distinct co-located entries, deduplicate IDs and retain nearby locations', () => {
  const a = feature('a');
  const b = feature('b');
  const nearby = feature('c', [8.50001, 50.5]);
  const groups = groupPublications([b, a, a, nearby]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].features.map((item) => item.properties.id), ['a', 'b']);
  assert.deepEqual(groups[1].features, [nearby]);
  assert.deepEqual(groupPublications([]), []);
});

test('tooltip identities survive reordering and content signatures reflect changed entries', () => {
  const first = groupPublications([feature('b'), feature('a')])[0];
  const reordered = groupPublications([feature('a'), feature('b')])[0];
  assert.equal(first.id, reordered.id);
  assert.equal(first.signature, reordered.signature);
  const changed = groupPublications([feature('a', [8.5, 50.5], 'Neuer Name'), feature('b')])[0];
  assert.equal(first.id, changed.id);
  assert.notEqual(first.signature, changed.signature);
  const removed = groupPublications([feature('a')])[0];
  assert.notEqual(first.signature, removed.signature);
});

test('a late response cannot replace the newest data or settle its loading state', async () => {
  const request = createLatestRequest();
  const old = deferred();
  const latest = deferred();
  const published = [];
  let oldSignal;
  const first = request.run((signal) => { oldSignal = signal; return old.promise; }, {
    success: (value) => published.push(value), settled: () => published.push('old settled'),
  });
  const second = request.run(() => latest.promise, {
    success: (value) => published.push(value), settled: () => published.push('latest settled'),
  });
  assert.equal(oldSignal.aborted, true);
  latest.resolve('new data');
  await second;
  old.resolve('old data');
  await first;
  assert.deepEqual(published, ['new data', 'latest settled']);
});

test('cancelled searches and geolocation callbacks cannot publish success or errors', async () => {
  for (const reject of [false, true]) {
    const request = createLatestRequest();
    const pending = deferred();
    const published = [];
    const running = request.run(() => pending.promise, {
      success: () => published.push('success'),
      error: () => published.push('error'),
      settled: () => published.push('settled'),
    });
    request.cancel();
    if (reject) pending.reject(new Error('Late error'));
    else pending.resolve('Late result');
    await running;
    assert.deepEqual(published, []);
  }
});

test('an old failure does not clear the loading state of a pending newer request', async () => {
  const request = createLatestRequest();
  const old = deferred();
  const latest = deferred();
  const published = [];
  const callbacks = { error: (error) => published.push(error.message), settled: () => published.push('settled') };
  const first = request.run(() => old.promise, callbacks);
  const second = request.run(() => latest.promise, callbacks);
  old.reject(new Error('Old failure'));
  await first;
  assert.deepEqual(published, []);
  latest.reject(new Error('Current failure'));
  await second;
  assert.deepEqual(published, ['Current failure', 'settled']);
});
