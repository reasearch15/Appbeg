import { NextResponse } from 'next/server';

import {
  getCashoutCoadminOutboxRowsAfter,
  getLatestCashoutCoadminOutboxId,
} from '@/lib/sql/liveOutbox';
import { getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';

function authorized(request: Request) {
  const expected = String(process.env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();
  if (!expected) {
    return { ok: false as const, status: 500, error: 'Internal API token is not configured.' };
  }
  const provided = String(request.headers.get('x-appbeg-ledger-token') || '').trim();
  if (!provided || provided !== expected) {
    return { ok: false as const, status: 401, error: 'Unauthorized.' };
  }
  return { ok: true as const };
}

/**
 * Authenticated Ledger poll of coadmin cash-out live_outbox events.
 * Returns all cashout_* event types (Phase 3 sends only on cashout_task_created;
 * Phase 4 can edit from later events). Does not mark rows consumed.
 */
export async function GET(request: Request) {
  const auth = authorized(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  if (!getPlayerMirrorPool()) {
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE' }, { status: 503 });
  }

  try {
    const url = new URL(request.url);
    const afterRaw = Number(url.searchParams.get('afterOutboxId') || '0');
    const limitRaw = Number(url.searchParams.get('limit') || '50');
    const afterOutboxId = Number.isFinite(afterRaw) ? Math.max(0, Math.floor(afterRaw)) : 0;
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 200) : 50;

    const events = await getCashoutCoadminOutboxRowsAfter(afterOutboxId, limit);
    const latestOutboxId = await getLatestCashoutCoadminOutboxId();

    return NextResponse.json({
      ok: true,
      afterOutboxId,
      latestOutboxId,
      events: events.map((row) => ({
        outboxId: row.outbox_id,
        channel: row.channel,
        eventType: row.event_type,
        entityType: row.entity_type,
        entityId: row.entity_id,
        payload: row.payload,
        source: row.source,
        mirroredAt: row.mirrored_at,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('[LEDGER_CASHOUT_OUTBOX] failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE' }, { status: 503 });
  }
}
