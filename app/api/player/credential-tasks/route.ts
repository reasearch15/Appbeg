import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import {
  getCoadminMaintenanceBreak,
  maintenanceBreakApiResponse,
} from '@/lib/maintenance/admin';
import {
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import {

  createPlayerCredentialTaskInSql,
  type PlayerCredentialTaskType,
} from '@/lib/sql/authorityPlayerCredentialTasks';

export const runtime = 'nodejs';

const ROUTE = '/api/player/credential-tasks';

function cleanText(value: unknown) {
  return String(value || '').trim();
}

function parseTaskType(value: unknown): PlayerCredentialTaskType | null {
  const normalized = cleanText(value).toLowerCase();
  if (normalized === 'reset_password' || normalized === 'recreate_username') {
    return normalized;
  }
  return null;
}

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['player']);
    if ('response' in auth) {
      return auth.response;
    }

    const maintenanceCoadminUid =
      cleanText(auth.user.coadminUid) || cleanText(auth.user.createdBy);
    if (maintenanceCoadminUid) {
      const maintenanceBreak = await getCoadminMaintenanceBreak(maintenanceCoadminUid);
      if (maintenanceBreak.enabled) {
        return maintenanceBreakApiResponse(maintenanceBreak.message);
      }
    }

    const body = (await request.json().catch(() => ({}))) as {
      taskType?: unknown;
      gameName?: unknown;
      gameLoginId?: unknown;
      playerUsername?: unknown;
      coadminUid?: unknown;
      idempotencyKey?: unknown;
    };

    const taskType = parseTaskType(body.taskType);
    const gameName = cleanText(body.gameName);
    const gameLoginId = cleanText(body.gameLoginId) || null;
    const playerUsername = cleanText(body.playerUsername) || auth.user.username || 'Player';
    const coadminUidHint =
      cleanText(body.coadminUid) ||
      cleanText(auth.user.coadminUid) ||
      cleanText(auth.user.createdBy) ||
      null;
    const idempotencyKey =
      cleanText(body.idempotencyKey || request.headers.get('Idempotency-Key')) || null;

    if (!taskType) {
      return apiError('taskType must be reset_password or recreate_username.', 400);
    }
    if (!gameName) {
      return apiError('gameName is required.', 400);
    }

    if (!isAuthoritySqlWriteEnabled()) {
      return apiError('SQL authority is required for credential tasks.', 503);
    }

    const result = await createPlayerCredentialTaskInSql({
      playerUid: auth.user.uid,
      playerUsername,
      gameName,
      taskType,
      coadminUidHint,
      gameLoginId,
      idempotencyKey,
    });

    logAuthoritySqlWrite(ROUTE, {
      playerUid: auth.user.uid,
      taskType,
      gameName,
      taskId: result.taskId,
      duplicate: result.duplicate,
    });

    return NextResponse.json({
      authority: 'sql',
      taskId: result.taskId,
      coadminUid: result.coadminUid,
      gameLoginId: result.gameLoginId,
      insertedTask: result.insertedTask,
      outboxChannels: result.outboxChannels,
      duplicate: result.duplicate ?? false,
      reopened: result.reopened ?? false,
      existingStatus: result.existingStatus ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to create credential task.';
    const status = /forbidden|does not belong/i.test(message)
      ? 403
      : /not found|required|disabled|scope/i.test(message)
        ? 400
        : /unavailable|pool/i.test(message)
          ? 503
          : 409;
    console.error('[PLAYER_CREDENTIAL_TASK_ERROR]', {
      route: ROUTE,
      message,
    });
    return NextResponse.json({ error: message }, { status });
  }
}
