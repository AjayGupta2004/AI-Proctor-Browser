'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Set a deterministic secret before loading the config module. dotenv does not
// overwrite an existing environment variable unless explicitly configured to.
process.env.KIOSK_SECRET = 'test-only-kiosk-secret-for-unit-tests';

const {
  verifyKioskAttestation,
  corsOriginCheck,
} = require('../config');

function makeAttestation({
  isKiosk = true,
  timestamp = Date.now(),
  secret = process.env.KIOSK_SECRET,
} = {}) {
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`kiosk:${isKiosk}:${timestamp}`)
    .digest('hex');

  return { isKiosk, timestamp, signature };
}

test('accepts a valid, current kiosk attestation', () => {
  assert.equal(verifyKioskAttestation(makeAttestation()), true);
});

test('rejects an attestation when kiosk mode is false', () => {
  assert.equal(verifyKioskAttestation(makeAttestation({ isKiosk: false })), false);
});

test('rejects missing or incomplete attestations', () => {
  assert.equal(verifyKioskAttestation(null), false);
  assert.equal(verifyKioskAttestation(undefined), false);
  assert.equal(verifyKioskAttestation({ isKiosk: true }), false);
});

test('rejects attestations older than five minutes', () => {
  const timestamp = Date.now() - (5 * 60 * 1000) - 1;
  assert.equal(verifyKioskAttestation(makeAttestation({ timestamp })), false);
});

test('rejects attestations more than thirty seconds in the future', () => {
  const timestamp = Date.now() + 30_001;
  assert.equal(verifyKioskAttestation(makeAttestation({ timestamp })), false);
});

test('rejects a signature made with a different secret', () => {
  assert.equal(
    verifyKioskAttestation(makeAttestation({ secret: 'a-different-secret' })),
    false,
  );
});

test('rejects malformed signatures without throwing', () => {
  const attestation = makeAttestation();
  attestation.signature = 'not-a-valid-hex-signature';
  assert.equal(verifyKioskAttestation(attestation), false);
});

function checkCors(origin) {
  let result;
  corsOriginCheck(origin, (error, allowed) => {
    result = { error, allowed };
  });
  return result;
}

test('allows requests without an Origin header', () => {
  assert.deepEqual(checkCors(undefined), { error: null, allowed: true });
});

test('allows local file origins used by the Electron renderer', () => {
  assert.deepEqual(checkCors('file://'), { error: null, allowed: true });
});

test('allows configured localhost origins', () => {
  assert.deepEqual(checkCors('http://localhost:4000'), { error: null, allowed: true });
});

test('rejects an origin that is not on the allow-list', () => {
  const result = checkCors('https://untrusted.example');
  assert.equal(result.allowed, undefined);
  assert.match(result.error.message, /not allowed/);
});
