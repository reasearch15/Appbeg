import { NextResponse } from 'next/server';

import { completePlayerCashoutTaskInSql } from '@/lib/sql/authorityCashout';
import {
  telegramCashoutCompleteIdempotencyKey,
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

function serializeTask(task: NonNullable<Awaited<ReturnType<typeof readPlayerCashoutTaskCacheById>>>) {
  return {
    taskId: task.id,
    coadminUid: task.coadminUid || null,
    playerUsername: task.playerUsername || null,
    amountNpr: Number(task.amountNpr || 0),
    payoutMethod: task.payoutMethod || null,
    paymentAppName: task.paymentAppName || null,
    createdAt: task.createdAt || null,
    status: task.status || null,
    expiresAt: task.expiresAt || null,
    assignedHandlerUsername: task.assignedHandlerUsername || null,
    startedAt: task.startedAt || null,
    completedAt: task.completedAt || null,
    operationalAttribution: task.operationalAttribution || null,
    operationalClaim: task.operationalClaim || null,
    operationalCompletion: task.operationalCompletion || null,
  };
}

/**
 * Ledger → AppBeg M2M Telegram DONE.
 * Financial/internal actor = owning Coadmin.
 * Telegram identity is operational attribution only.
 * Requires current Telegram claim by the same telegramUserId.
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
        ? telegramCashoutCompleteIdempotencyKey(taskId, telegramUserId)
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
      console.warn('[LEDGER_CASHOUT_COMPLETE] tenant_mismatch', { taskId });
      return NextResponse.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    }

    const status = cleanText(task.status).toLowerCase();

    // Soft reconcile when already completed (replay / race loser).
    if (status === 'completed') {
      return NextResponse.json({
        ok: true,
        duplicate: true,
        alreadyCompleted: true,
        taskId,
        task: serializeTask(task),
      });
    }

    if (status !== 'in_progress') {
      return NextResponse.json(
        {
          ok: false,
          error: 'NOT_CLAIMABLE',
          reason: 'not_in_progress',
          task: serializeTask(task),
        },
        { status: 409 }
      );
    }

    const claim = task.operationalClaim;
    if (
      cleanText(claim?.actionSource) !== 'telegram' ||
      cleanText(claim?.telegramUserId) !== telegramUserId
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: 'NOT_CLAIMANT',
          task: serializeTask(task),
        },
        { status: 403 }
      );
    }

    const coadminUsername = await resolveCoadminUsername(taskCoadminUid);
    if (!coadminUsername) {
      return NextResponse.json({ ok: false, error: 'COADMIN_NOT_FOUND' }, { status: 404 });
    }

    // Authority operation key uses short suffix; ops event uses full cashout_complete:... key.
    const authorityIdempotency = `telegram:${telegramUserId}`;

    const result = await completePlayerCashoutTaskInSql({
      taskId,
      actorUid: taskCoadminUid,
      actorUsername: coadminUsername,
      actorRole: 'coadmin',
      isAdmin: false,
      scopeUid: taskCoadminUid,
      idempotencyKey: authorityIdempotency,
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
      alreadyCompleted: Boolean(result.alreadyCompleted),
      taskId: result.taskId,
      task: refreshed ? serializeTask(refreshed) : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Only the Telegram claimant/i.test(message)) {
      return NextResponse.json({ ok: false, error: 'NOT_CLAIMANT' }, { status: 403 });
    }
    if (/must be claimed before Telegram completion/i.test(message)) {
      return NextResponse.json(
        { ok: false, error: 'NOT_CLAIMABLE', reason: 'not_in_progress' },
        { status: 409 }
      );
    }
    if (/Forbidden/i.test(message)) {
      return NextResponse.json({ ok: false, error: 'FORBIDDEN' }, { status: 403 });
    }
    if (/not found/i.test(message)) {
      return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
    }
    if (/not available to complete/i.test(message)) {
      return NextResponse.json(
        { ok: false, error: 'NOT_CLAIMABLE', reason: 'not_available' },
        { status: 409 }
      );
    }

    console.error('[LEDGER_CASHOUT_COMPLETE] failed', { error: message });
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE' }, { status: 503 });
  }
}
