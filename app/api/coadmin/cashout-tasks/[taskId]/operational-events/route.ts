import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import { listCashoutOperationalEventsByTaskId } from '@/lib/sql/cashoutOperationalEvents';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';
import { readPlayerCashoutTaskCacheById } from '@/lib/sql/playerCashoutTasksCache';

export const runtime = 'nodejs';

/**
 * Phase 7: clean API for operational event history (no dashboard UI yet).
 * Coadmin-scoped; returns telegram_claim / telegram_complete / etc. for one task.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ taskId: string }> | { taskId: string } }
) {
  const auth = await requireApiUser(request, ['coadmin']);
  if ('response' in auth) return auth.response;

  if (!getPlayerMirrorPool()) {
    return NextResponse.json({ error: 'Unavailable.' }, { status: 503 });
  }

  try {
    const params = await Promise.resolve(context.params);
    const taskId = cleanText(params?.taskId);
    if (!taskId) {
      return NextResponse.json({ error: 'Missing task id.' }, { status: 400 });
    }

    const task = await readPlayerCashoutTaskCacheById(taskId);
    if (!task || cleanText(task.coadminUid) !== auth.user.uid) {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }

    const events = await listCashoutOperationalEventsByTaskId(taskId, {
      coadminUid: auth.user.uid,
      limit: 100,
    });

    return NextResponse.json({
      taskId,
      operationalClaim: task.operationalClaim || null,
      operationalCompletion: task.operationalCompletion || null,
      events,
    });
  } catch (error) {
    console.error('[COADMIN_CASHOUT_OPERATIONAL_EVENTS] failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Unable to load operational history.' }, { status: 503 });
  }
}
