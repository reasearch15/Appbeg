'use strict';

/**
 * Static contract checks for M2M GET /api/internal/ledger/cashout-tasks/[taskId]:
 * - exposes qrImageUrl when present
 * - never exposes paymentDetails / payout destination secrets
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ROUTE = path.join(
  ROOT,
  'app/api/internal/ledger/cashout-tasks/[taskId]/route.ts'
);

function run() {
  const source = fs.readFileSync(ROUTE, 'utf8');

  assert.match(source, /qrImageUrl/, 'M2M route must expose qrImageUrl');
  assert.match(
    source,
    /\.\.\.\(qrImageUrl \? \{ qrImageUrl \} : \{\}\)/,
    'qrImageUrl must be included only when present'
  );
  assert.match(
    source,
    /cleanText\(task\.qrImageUrl\)/,
    'qrImageUrl must be read from the task domain field'
  );

  // Sensitive payout fields must not be assigned into the M2M response object keys.
  assert.doesNotMatch(
    source,
    /paymentDetails\s*:/,
    'paymentDetails must not be exposed on M2M task read'
  );
  assert.doesNotMatch(
    source,
    /payment_details\s*:/,
    'payment_details must not be exposed on M2M task read'
  );
  assert.doesNotMatch(source, /cashTag\s*:/i, 'Cash Tag secrets must not be exposed');
  assert.doesNotMatch(
    source,
    /gamePassword\s*:|playerPassword\s*:/,
    'game credentials must not be exposed as response fields'
  );

  console.log('PASS: ledger cashout-task M2M qrImageUrl contract');
}

run();
