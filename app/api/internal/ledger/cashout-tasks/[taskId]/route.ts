import { NextResponse } from 'next/server';

import { readPlayerCashoutTaskCacheById } from '@/lib/sql/playerCashoutTasksCache';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

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
 * Narrow M2M cash-out task read for Ledger Telegram notification rendering.
 * Omits payment destination secrets and game credentials.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string }> | { taskId: string } }
) {
  const auth = authorized(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  if (!getPlayerMirrorPool()) {
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE' }, { status: 503 });
  }

  try {
    const params = await Promise.resolve(context.params);
    const taskId = cleanText(params?.taskId);
    if (!taskId) {
      return NextResponse.json({ ok: false, error: 'MISSING_TASK_ID' }, { status: 400 });
    }

    const task = await readPlayerCashoutTaskCacheById(taskId);
    if (!task) {
      return NextResponse.json({ ok: false, error: 'NOT_FOUND' }, { status: 404 });
    }

    const vendor = task.vendor;
    const vendorCode =
      vendor && vendor.configured === true && vendor.owned === true
        ? cleanText(vendor.code) || null
        : null;
    const vendorName =
      vendor && vendor.configured === true && vendor.owned === true
        ? cleanText(vendor.name) || null
        : null;

    return NextResponse.json({
      ok: true,
      task: {
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
        vendorCode,
        vendorName,
      },
    });
  } catch (error) {
    console.error('[LEDGER_CASHOUT_TASK_READ] failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE' }, { status: 503 });
  }
}
