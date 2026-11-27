import assert from 'node:assert/strict';
import test from 'node:test';

import { canOpenPhoto, hrefHash, listedForViewer } from './photoAccess.js';

test('private photo opens only for the owner', () => {
  const base = { visibility: 'private', ownerId: 'owner', granted: false };
  assert.equal(canOpenPhoto({ ...base, viewerId: 'owner' }), true);
  assert.equal(canOpenPhoto({ ...base, viewerId: 'other', granted: true }), false);
  assert.equal(canOpenPhoto({ ...base, viewerId: null }), false);
});

test('link and public photos open without a login', () => {
  assert.equal(canOpenPhoto({ visibility: 'link', ownerId: 'owner', viewerId: null, granted: false }), true);
  assert.equal(canOpenPhoto({ visibility: 'public', ownerId: 'owner', viewerId: null, granted: false }), true);
});

test('people photos open for the owner and granted accounts', () => {
  assert.equal(canOpenPhoto({ visibility: 'people', ownerId: 'owner', viewerId: 'owner', granted: false }), true);
  assert.equal(canOpenPhoto({ visibility: 'people', ownerId: 'owner', viewerId: 'guest', granted: true }), true);
  assert.equal(canOpenPhoto({ visibility: 'people', ownerId: 'owner', viewerId: 'guest', granted: false }), false);
  assert.equal(canOpenPhoto({ visibility: 'people', ownerId: 'owner', viewerId: null, granted: true }), false);
});

test('shared gallery lists people and public grants', () => {
  assert.equal(listedForViewer('people'), true);
  assert.equal(listedForViewer('public'), true);
  assert.equal(listedForViewer('link'), false);
  assert.equal(listedForViewer('private'), false);
});

test('photo hash stays stable and hides the address', () => {
  const hash = hrefHash('https://cdn.example/a.jpg');
  assert.equal(hash, hrefHash('https://cdn.example/a.jpg'));
  assert.notEqual(hash, hrefHash('https://cdn.example/b.jpg'));
  assert.equal(hash.length, 64);
  assert.equal(hash.includes('cdn.example'), false);
});
