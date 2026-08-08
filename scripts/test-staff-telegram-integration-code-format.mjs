/**
 * Offline unit checks for Staff Telegram Integration Code format helpers.
 * Full DB-backed create/rotate/validate tests require AppBeg Postgres + auth and are not run here.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PREFIX = 'STG-';

function normalizeStaffTelegramIntegrationCode(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

function makeCode() {
  const bytes = randomBytes(12);
  let value = CODE_PREFIX;
  for (const byte of bytes) value += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return value;
}

function codeHash(code) {
  return createHash('sha256').update(normalizeStaffTelegramIntegrationCode(code)).digest('hex');
}

const code = makeCode();
assert.match(code, /^STG-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/);
assert.equal(normalizeStaffTelegramIntegrationCode('  stg-abcd 1234 efgh '), 'STG-ABCD1234EFGH');
assert.equal(codeHash('STG-AAAA'), codeHash(' stg-aaaa '));
assert.notEqual(codeHash('STG-AAAA'), codeHash('STG-BBBB'));

const set = new Set();
for (let i = 0; i < 50; i += 1) set.add(makeCode());
assert.equal(set.size, 50);

console.log('Staff Telegram Integration Code format checks passed.');
