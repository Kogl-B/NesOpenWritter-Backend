import assert from 'node:assert/strict';
import test from 'node:test';

import { driveReturnOrigin, newDriveOAuth, readDriveOAuth } from './driveOAuth.js';
import { isBrowserMutationAllowed } from './requestSecurity.js';
import { presignUploadSchema } from './schemas.js';

const origin = 'https://openwritter.app';
const trustedOrigins = new Set([origin]);

test('browser mutations require the configured origin and service requests remain usable', () => {
  const cookie = 'session=test';
  assert.equal(isBrowserMutationAllowed('POST', { origin, cookie }, trustedOrigins), true);
  assert.equal(isBrowserMutationAllowed('POST', { origin: 'null', cookie }, trustedOrigins), false);
  assert.equal(isBrowserMutationAllowed('POST', { cookie }, trustedOrigins), false);
  assert.equal(isBrowserMutationAllowed('POST', { 'sec-fetch-site': 'cross-site' }, trustedOrigins), false);
  assert.equal(isBrowserMutationAllowed('POST', {}, trustedOrigins), true);
  assert.equal(isBrowserMutationAllowed('GET', { cookie }, trustedOrigins), true);
});

test('Drive OAuth is scoped to the initiating session and expires', () => {
  const flow = newDriveOAuth('first-session', origin);
  const saved = JSON.stringify(flow);
  assert.equal(driveReturnOrigin(flow.state), origin);
  assert.equal(driveReturnOrigin('invalid'), null);
  assert.deepEqual(readDriveOAuth(saved, flow.state, 'first-session'), flow);
  assert.notEqual(newDriveOAuth('first-session', origin).state, flow.state);
  assert.equal(readDriveOAuth(saved, flow.state, 'another-session'), null);
  assert.equal(readDriveOAuth(null, flow.state, 'first-session'), null);
  const expired = JSON.stringify({ ...flow, expiresAt: Date.now() - 1 });
  assert.equal(readDriveOAuth(expired, flow.state, 'first-session'), null);
});

test('presigned uploads require a bounded size and a supported image type', () => {
  const upload = { filename: 'cover.png', contentType: 'image/png', sizeBytes: 1024 };
  assert.equal(presignUploadSchema.safeParse(upload).success, true);
  assert.equal(presignUploadSchema.safeParse({ ...upload, contentType: 'text/html' }).success, false);
  assert.equal(presignUploadSchema.safeParse({ ...upload, sizeBytes: undefined }).success, false);
  assert.equal(presignUploadSchema.safeParse({ ...upload, sizeBytes: 51 * 1024 * 1024 }).success, false);
});
