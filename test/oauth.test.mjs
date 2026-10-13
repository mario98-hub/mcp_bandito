import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { createJwtVerifier, parseHouseholds, tenantForUser, tenantOf } from '../dist/server/oauth.js';
import { DEFAULT_TENANT } from '../dist/store/store.js';

const ISSUER = 'https://auth.example.com';
const AUD = 'https://conti.example.com';

// An RS256 signing key, exposed as a JWK for the verifier.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function mintJwt(claims, { kid = 'test-key', key = privateKey } = {}) {
  const header = b64({ alg: 'RS256', kid, typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64({ iss: ISSUER, aud: AUD, iat: now, exp: now + 3600, ...claims });
  const sig = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), key).toString('base64url');
  return `${header}.${payload}.${sig}`;
}

const verifier = createJwtVerifier({ issuer: ISSUER, jwks: { keys: [jwk] }, audience: AUD });

test('oauth: verifies a valid token and maps the subject to a stable tenant', async () => {
  const token = mintJwt({ sub: 'user-123', scope: 'mcp profile', client_id: 'claude' });
  const info = await verifier.verifyAccessToken(token);
  assert.equal(info.extra.sub, 'user-123');
  assert.equal(info.clientId, 'claude');
  assert.deepEqual(info.scopes, ['mcp', 'profile']);
  assert.ok(info.expiresAt > Math.floor(Date.now() / 1000));
  assert.equal(info.extra.tenant, tenantForUser(ISSUER, 'user-123'));
  // the tenant is opaque, stable and namespaced away from the default/self-host tenant
  assert.match(info.extra.tenant, /^u:/);
  assert.notEqual(info.extra.tenant, DEFAULT_TENANT);
  assert.equal(tenantOf(info), info.extra.tenant);
});

test('oauth: tenantOf falls back to the default tenant without auth', () => {
  assert.equal(tenantOf(undefined), DEFAULT_TENANT);
  assert.equal(tenantOf({ extra: {} }), DEFAULT_TENANT);
});

test('oauth: different subjects get different tenants, same subject is stable', async () => {
  const a = await verifier.verifyAccessToken(mintJwt({ sub: 'alice' }));
  const b = await verifier.verifyAccessToken(mintJwt({ sub: 'bob' }));
  const a2 = await verifier.verifyAccessToken(mintJwt({ sub: 'alice' }));
  assert.notEqual(a.extra.tenant, b.extra.tenant);
  assert.equal(a.extra.tenant, a2.extra.tenant);
});

test('oauth: parseHouseholds maps listed emails/subs to a shared tenant, others to none', () => {
  assert.equal(parseHouseholds(undefined), undefined);
  assert.equal(parseHouseholds('   '), undefined);

  // bare list → the shared default tenant; matching is case-insensitive on email
  const def = parseHouseholds('ada@ex.com, Grace@Ex.com');
  assert.equal(def({ iss: ISSUER, sub: 'a', email: 'ADA@ex.com' }), DEFAULT_TENANT);
  assert.equal(def({ iss: ISSUER, sub: 'b', email: 'grace@ex.com' }), DEFAULT_TENANT);
  assert.equal(def({ iss: ISSUER, sub: 'c', email: 'stranger@ex.com' }), undefined);
  assert.equal(def({ iss: ISSUER, sub: 'd' }), undefined); // no email, no sub match

  // named tenants, multiple groups, and sub: matching when there is no email
  const multi = parseHouseholds('ada@ex.com, bob@ex.com => casa; sub:xyz => casa; dana@ex.com => altra');
  assert.equal(multi({ iss: ISSUER, sub: '1', email: 'bob@ex.com' }), 'casa');
  assert.equal(multi({ iss: ISSUER, sub: 'xyz' }), 'casa');
  assert.equal(multi({ iss: ISSUER, sub: '2', email: 'dana@ex.com' }), 'altra');
  assert.equal(multi({ iss: ISSUER, sub: '3', email: 'nobody@ex.com' }), undefined);
});

test('oauth: a verifier with a household allowlist shares a tenant across subjects', async () => {
  const shared = createJwtVerifier({
    issuer: ISSUER,
    jwks: { keys: [jwk] },
    audience: AUD,
    households: parseHouseholds('ada@ex.com, grace@ex.com'),
  });
  // two DIFFERENT subjects, both on the allowlist → the same (default) tenant
  const ada = await shared.verifyAccessToken(mintJwt({ sub: 'subject-ada', email: 'ada@ex.com' }));
  const grace = await shared.verifyAccessToken(mintJwt({ sub: 'subject-grace', email: 'grace@ex.com' }));
  assert.equal(ada.extra.tenant, DEFAULT_TENANT);
  assert.equal(grace.extra.tenant, DEFAULT_TENANT);
  assert.equal(tenantOf(ada), tenantOf(grace));
  // a non-listed user keeps their own isolated tenant
  const other = await shared.verifyAccessToken(mintJwt({ sub: 'subject-x', email: 'x@ex.com' }));
  assert.equal(other.extra.tenant, tenantForUser(ISSUER, 'subject-x'));
  assert.notEqual(other.extra.tenant, DEFAULT_TENANT);
});

test('oauth: rejects expired, wrong-issuer, wrong-audience, unknown-key and tampered tokens', async () => {
  const now = Math.floor(Date.now() / 1000);
  const expired = (() => {
    const header = b64({ alg: 'RS256', kid: 'test-key', typ: 'JWT' });
    const payload = b64({ iss: ISSUER, aud: AUD, sub: 'x', iat: now - 7200, exp: now - 3600 });
    const s = cryptoSign('sha256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
    return `${header}.${payload}.${s}`;
  })();
  await assert.rejects(() => verifier.verifyAccessToken(expired), /expired/i);
  await assert.rejects(() => verifier.verifyAccessToken(mintJwt({ sub: 'x', iss: 'https://evil.example' })), /issuer/i);
  await assert.rejects(() => verifier.verifyAccessToken(mintJwt({ sub: 'x', aud: 'https://other' })), /audience/i);

  // signed by a different key → no matching/validating signature
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await assert.rejects(() => verifier.verifyAccessToken(mintJwt({ sub: 'x' }, { key: other.privateKey })), /signature|signing key/i);

  // tampered payload
  const good = mintJwt({ sub: 'x' });
  const [h, , sg] = good.split('.');
  const forged = `${h}.${b64({ iss: ISSUER, aud: AUD, sub: 'admin', exp: now + 3600 })}.${sg}`;
  await assert.rejects(() => verifier.verifyAccessToken(forged), /signature/i);

  await assert.rejects(() => verifier.verifyAccessToken('not-a-jwt'), /malformed/i);
});
