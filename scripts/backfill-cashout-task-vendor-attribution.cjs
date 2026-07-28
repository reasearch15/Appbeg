/**
 * Backfill vendor attribution onto pending cashout tasks from Ledger ownership.
 *
 * Usage:
 *   node scripts/backfill-cashout-task-vendor-attribution.cjs --dry-run
 *   node scripts/backfill-cashout-task-vendor-attribution.cjs
 */
const { Pool } = require('pg');

const dryRun = process.argv.includes('--dry-run');
const DATABASE_URL = String(process.env.DATABASE_URL || '').trim();
const LEDGER_URL = String(
  process.env.APPBEG_LEDGER_INTERNAL_URL || process.env.APPBEG_LEDGER_URL || ''
)
  .trim()
  .replace(/\/+$/, '');
const LEDGER_KEY = String(
  process.env.APPBEG_LEDGER_VENDOR_INTERNAL_API_KEY ||
    process.env.APPBEG_LEDGER_INTERNAL_API_KEY ||
    ''
).trim();

function clean(value) {
  return String(value || '').trim();
}

function vendorIdOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

async function fetchOwnership(playerUids) {
  if (!LEDGER_URL || !LEDGER_KEY) {
    throw new Error('APPBEG_LEDGER_INTERNAL_URL and API key are required for backfill.');
  }
  const response = await fetch(`${LEDGER_URL}/api/internal/vendor-ownership`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${LEDGER_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ playerUids }),
  });
  if (!response.ok) {
    throw new Error(`Ledger ownership failed with status ${response.status}`);
  }
  return response.json();
}

async function main() {
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL is required.');
  }
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const { rows } = await pool.query(
      `
        SELECT firebase_id, player_uid, vendor_id, vendor_code, vendor_resolved_at
        FROM public.player_cashout_tasks_cache
        WHERE deleted_at IS NULL
          AND LOWER(COALESCE(status, '')) IN ('pending', 'in_progress')
          AND (
            vendor_resolved_at IS NULL
            OR (vendor_code IS NULL AND vendor_id IS NULL)
          )
        ORDER BY created_at DESC NULLS LAST
        LIMIT 500
      `
    );
    console.info('[BACKFILL_CASHOUT_VENDOR] candidates', { count: rows.length, dryRun });
    if (!rows.length) {
      return;
    }

    const playerUids = [...new Set(rows.map((row) => clean(row.player_uid)).filter(Boolean))];
    const ownership = await fetchOwnership(playerUids);
    const players = ownership.players || {};
    const nowIso = new Date().toISOString();
    let updated = 0;
    let unassigned = 0;
    let unavailable = 0;

    for (const row of rows) {
      const taskId = clean(row.firebase_id);
      const playerUid = clean(row.player_uid);
      const value = players[playerUid];
      let fields = {
        vendor_id: null,
        vendor_code: null,
        vendor_name: null,
        vendor_status: null,
        vendor_linked_staff_uid: null,
        vendor_ownership_date: null,
        vendor_resolved_at: nowIso,
      };

      if (!value || value.owned === false) {
        unassigned += 1;
      } else {
        const vendorCode = clean(value.vendorCode);
        const vendorName = clean(value.vendorName);
        if (!vendorCode || !vendorName) {
          unavailable += 1;
          fields.vendor_resolved_at = null;
          console.warn('[BACKFILL_CASHOUT_VENDOR] incomplete_ownership', { taskId, playerUid });
          continue;
        }
        fields = {
          vendor_id: vendorIdOrNull(value.vendorId),
          vendor_code: vendorCode,
          vendor_name: vendorName,
          vendor_status: clean(value.vendorStatus) || 'active',
          vendor_linked_staff_uid: clean(value.linkedStaffUid) || null,
          vendor_ownership_date: clean(value.ownershipDate) || null,
          vendor_resolved_at: nowIso,
        };
        updated += 1;
      }

      if (dryRun) {
        console.info('[BACKFILL_CASHOUT_VENDOR] dry_run', { taskId, playerUid, ...fields });
        continue;
      }

      await pool.query(
        `
          UPDATE public.player_cashout_tasks_cache
          SET
            vendor_id = $2::bigint,
            vendor_code = NULLIF($3::text, ''),
            vendor_name = NULLIF($4::text, ''),
            vendor_status = NULLIF($5::text, ''),
            vendor_linked_staff_uid = NULLIF($6::text, ''),
            vendor_ownership_date = $7::timestamptz,
            vendor_resolved_at = $8::timestamptz,
            raw_firestore_data = COALESCE(raw_firestore_data, '{}'::jsonb) || $9::jsonb,
            mirrored_at = now()
          WHERE firebase_id = $1
            AND deleted_at IS NULL
        `,
        [
          taskId,
          fields.vendor_id,
          fields.vendor_code,
          fields.vendor_name,
          fields.vendor_status,
          fields.vendor_linked_staff_uid,
          fields.vendor_ownership_date,
          fields.vendor_resolved_at,
          JSON.stringify({
            vendorId: fields.vendor_id,
            vendorCode: fields.vendor_code,
            vendorName: fields.vendor_name,
            vendorStatus: fields.vendor_status,
            vendorLinkedStaffUid: fields.vendor_linked_staff_uid,
            vendorOwnershipDate: fields.vendor_ownership_date,
            vendorResolvedAt: fields.vendor_resolved_at,
          }),
        ]
      );
    }

    console.info('[BACKFILL_CASHOUT_VENDOR] done', {
      dryRun,
      candidates: rows.length,
      linkedUpdated: updated,
      unassignedMarked: unassigned,
      incompleteSkipped: unavailable,
    });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
