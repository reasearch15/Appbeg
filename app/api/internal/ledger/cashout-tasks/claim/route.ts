import { NextResponse } from 'next/server';

import { CashoutClaimConflictError } from '@/lib/cashouts/playerCashoutClaimConflict';
import { startPlayerCashoutTaskInSql } from '@/lib/sql/authorityCashout';
import {
  telegramCashoutClaimIdempotencyKey,
} from '@/lib/sql/cashoutOperationalEvents';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import { readPlayerCashoutTaskCacheById } from '@/lib/sql/playerCashoutTasksCache';

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

async function resolveCoadminUsername(coadminUid: string): Promise<string | null> {
  const db = getPlayerMirrorPool();
  if (!db) return null;
  const result = await db.query(
    `
      SELECT username
      FROM public.players_cache
      WHERE uid = $1::text
        AND role = 'coadmin'
        AND deleted_at IS NULL
      LIMIT 1
    `,
    [coadminUid]
  );
  return cleanText(result.rows[0]?.username) || null;
}

/**
 * Ledger → AppBeg M2M Telegram CLAIM.
 * Financial/internal actor = owning Coadmin.
 * Telegram identity is operational attribution only.
 */
export async function POST(request: Request) {
  const auth = authorized(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  if (!getPlayerMirrorPool()) {
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE' }, { status: 503 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const taskId = cleanText(body.taskId);
    const telegramUserId = cleanText(body.telegramUserId);
    const expectedCoadminUid = cleanText(body.expectedCoadminUid);
    const telegramUsername = cleanText(body.telegramUsername) || null;
    const telegramDisplayName = cleanText(body.telegramDisplayName) || null;
    const idempotencyKey =
      cleanText(body.idempotencyKey) ||
      (taskId && telegramUserId
        ? telegramCashoutClaimIdempotencyKey(taskId, telegramUserId)
        : null);

    if (!taskId || !telegramUserId || !expectedCoadminUid) {
      return NextResponse.json({ ok: false, error: 'INVALID_INPUT' }, { status: 400 });
    }

    const task = await readPlayerCashoutTaskCacheById(taskId);
    if (!task) {
      return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
    }

    const taskCoadminUid = cleanText(task.coadminUid);
    if (!taskCoadminUid || taskCoadminUid !== expectedCoadminUid) {
      console.warn('[LEDGER_CASHOUT_CLAIM] tenant_mismatch', {
        taskId,
        // Do not log expected vs actual coadmin values together in production detail;
        // keep high-level only.
      });
      return NextResponse.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    }

    const coadminUsername = await resolveCoadminUsername(taskCoadminUid);
    if (!coadminUsername) {
      return NextResponse.json({ ok: false, error: 'COADMIN_NOT_FOUND' }, { status: 404 });
    }

    const status = cleanText(task.status).toLowerCase();
    if (status !== 'pending' && status !== 'in_progress') {
      return NextResponse.json(
        {
          ok: false,
          error: 'NOT_CLAIMABLE',
          conflict: true,
          task: {
            taskId,
            status: task.status,
            claimedByUid: task.assignedHandlerUid || null,
            claimedAt: task.startedAt || null,
          },
        },
        { status: 409 }
      );
    }

    const result = await startPlayerCashoutTaskInSql({
      taskId,
      actorUid: taskCoadminUid,
      actorUsername: coadminUsername,
      actorRole: 'coadmin',
      isAdmin: false,
      scopeUid: taskCoadminUid,
      operationalActor: {
        actionSource: 'telegram',
        telegramUserId,
        telegramUsername,
        telegramDisplayName,
        idempotencyKey,
      },
    });

    const refreshed = await readPlayerCashoutTaskCacheById(taskId);

    return NextResponse.json({
      ok: true,
      duplicate: Boolean(result.duplicate),
      taskId: result.taskId,
      expiresAtMs: result.expiresAtMs,
      task: refreshed
        ? {
            taskId: refreshed.id,
            coadminUid: refreshed.coadminUid || null,
            playerUsername: refreshed.playerUsername || null,
            amountNpr: Number(refreshed.amountNpr || 0),
            payoutMethod: refreshed.payoutMethod || null,
            paymentAppName: refreshed.paymentAppName || null,
            createdAt: refreshed.createdAt || null,
            status: refreshed.status || null,
            expiresAt: refreshed.expiresAt || null,
            assignedHandlerUsername: refreshed.assignedHandlerUsername || null,
            startedAt: refreshed.startedAt || null,
            completedAt: refreshed.completedAt || null,
            operationalAttribution: refreshed.operationalAttribution || null,
            operationalClaim: refreshed.operationalClaim || null,
            operationalCompletion: refreshed.operationalCompletion || null,
          }
        : null,
    });
  } catch (error) {
    if (CashoutClaimConflictError.is(error)) {
      return NextResponse.json(
        {
          ok: false,
          error: 'ALREADY_CLAIMED',
          conflict: true,
          task: {
            taskId: error.snapshot.taskId,
            status: error.snapshot.status,
            claimedByUid: error.snapshot.claimedByUid,
            claimedAt: error.snapshot.claimedAt,
          },
        },
        { status: 409 }
      );
    }

    const message = error instanceof Error ? error.message : String(error);
    if (/Forbidden/i.test(message)) {
      return NextResponse.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    }
    if (/not found/i.test(message)) {
      return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
    }

    console.error('[LEDGER_CASHOUT_CLAIM] failed', { error: message });
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE' }, { status: 503 });
  }
}
