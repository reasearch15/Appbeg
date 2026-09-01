import 'server-only';

import type { PoolClient } from 'pg';

import {
  claimAuthorityOperation,
  logAuthPayloadPreTxnRemoved,
  readAuthorityOperationPayloadWithClient,
} from '@/lib/sql/authorityLedger';
import { normalizeGameName } from '@/lib/sql/authorityGameRequestHelpers';
import { scheduleAutoClaimPendingTaskOnCreate } from '@/lib/sql/authorityAutoClaim';
import {
  coadminTaskLiveChannel,
  insertLiveOutboxEventWithClient,
} from '@/lib/sql/liveOutbox';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export type PlayerCredentialTaskType = 'reset_password' | 'recreate_username';

const ACTIVE_CREDENTIAL_TASK_STATUSES = new Set([
  'pending',
  'in_progress',
  'urgent',
  'pending_review',
]);

const REOPENABLE_TERMINAL_CREDENTIAL_TASK_STATUSES = new Set(['completed']);

type CredentialCarerTaskRow = {
  firebase_id: string;
  status: string;
  assigned_carer_uid: string | null;
  assigned_carer_username: string | null;
  claimed_by_uid: string | null;
  claimed_by_username: string | null;
  claimed_at: string | null;
  coadmin_uid: string | null;
  deleted_at: string | null;
};

function credentialTaskId(
  taskType: PlayerCredentialTaskType,
  coadminUid: string,
  playerUid: string,
  gameName: string
) {
  const normalized = normalizeGameName(gameName);
  return `${taskType}__${coadminUid}__${playerUid}__${normalized}`;
}

function buildPendingCredentialTaskRaw(input: {
  taskId: string;
  coadminUid: string;
  taskType: PlayerCredentialTaskType;
  playerUid: string;
  playerUsername: string;
  gameName: string;
  currentUsername?: string | null;
  nowIso: string;
}) {
  return {
    id: input.taskId,
    coadminUid: input.coadminUid,
    type: input.taskType,
    playerUid: input.playerUid,
    playerUsername: input.playerUsername || 'Player',
    gameName: input.gameName.trim(),
    amount: null,
    requestId: null,
    status: 'pending',
    assignedCarerUid: null,
    assignedCarer: null,
    assignedCarerUsername: null,
    claimedStatus: null,
    claimedAt: null,
    claimedByUid: null,
    claimedByUsername: null,
    startedAt: null,
    runningAt: null,
    expiresAt: null,
    completedAt: null,
    cancelledAt: null,
    failedAt: null,
    ttlExpiresAt: null,
    completedByCarerUid: null,
    completedByCarerUsername: null,
    automationStatus: null,
    automationJobId: null,
    linkedJobId: null,
    currentJobId: null,
    activeJobId: null,
    assignedJobStatus: null,
    automationError: null,
    error: null,
    failureReason: null,
    retryPending: false,
    resetToPendingAt: null,
    returnedToPendingAt: null,
    pendingSince: input.nowIso,
    lastHeartbeatAt: null,
    queuedAt: null,
    automationUpdatedAt: input.nowIso,
    updatedAt: input.nowIso,
    createdAt: input.nowIso,
    currentUsername: cleanText(input.currentUsername) || null,
    gameAccountUsername: cleanText(input.currentUsername) || null,
    isPoked: false,
    pokedAt: null,
    pokeMessage: null,
  } as Record<string, unknown>;
}

async function loadPlayerProfileInTxn(client: PoolClient, playerUid: string) {
  const { rows } = await client.query(
    `
      SELECT uid, username, role, status, coadmin_uid, created_by, raw_firestore_data
      FROM public.players_cache
      WHERE uid = $1
        AND deleted_at IS NULL
      LIMIT 1
      FOR UPDATE
    `,
    [playerUid]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  const raw = (row.raw_firestore_data as Record<string, unknown>) || {};
  return {
    uid: cleanText(row.uid),
    username: cleanText(row.username) || 'Player',
    role: cleanText(row.role).toLowerCase(),
    status: (cleanText(row.status) || 'active').toLowerCase(),
    coadminUid:
      cleanText(row.coadmin_uid) ||
      cleanText(row.created_by) ||
      cleanText(raw.coadminUid) ||
      cleanText(raw.createdBy) ||
      '',
  };
}

async function loadPlayerGameLoginInTxn(
  client: PoolClient,
  input: {
    playerUid: string;
    gameName: string;
    gameLoginId?: string | null;
  }
) {
  const normalizedGame = normalizeGameName(input.gameName);
  if (input.gameLoginId) {
    const { rows } = await client.query(
      `
        SELECT firebase_id, player_uid, player_username, game_name, game_username,
               coadmin_uid, created_by
        FROM public.player_game_logins_cache
        WHERE firebase_id = $1
          AND deleted_at IS NULL
        LIMIT 1
      `,
      [cleanText(input.gameLoginId)]
    );
    const row = rows[0] as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    if (cleanText(row.player_uid) !== input.playerUid) {
      throw new Error('Forbidden: game login does not belong to this player.');
    }
    return {
      id: cleanText(row.firebase_id),
      playerUid: cleanText(row.player_uid),
      playerUsername: cleanText(row.player_username) || 'Player',
      gameName: cleanText(row.game_name),
      gameUsername: cleanText(row.game_username),
      coadminUid: cleanText(row.coadmin_uid) || cleanText(row.created_by),
    };
  }

  const { rows } = await client.query(
    `
      SELECT firebase_id, player_uid, player_username, game_name, game_username,
             coadmin_uid, created_by
      FROM public.player_game_logins_cache
      WHERE player_uid = $1
        AND deleted_at IS NULL
        AND normalized_game_name = $2
      ORDER BY COALESCE(updated_at, created_at, mirrored_at) DESC
      LIMIT 1
    `,
    [input.playerUid, normalizedGame]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    id: cleanText(row.firebase_id),
    playerUid: cleanText(row.player_uid),
    playerUsername: cleanText(row.player_username) || 'Player',
    gameName: cleanText(row.game_name),
    gameUsername: cleanText(row.game_username),
    coadminUid: cleanText(row.coadmin_uid) || cleanText(row.created_by),
  };
}

async function upsertCredentialCarerTaskInTxn(
  client: PoolClient,
  input: {
    taskId: string;
    coadminUid: string;
    taskType: PlayerCredentialTaskType;
    playerUid: string;
    playerUsername: string;
    gameName: string;
    currentUsername?: string | null;
    nowIso: string;
  }
) {
  const raw = buildPendingCredentialTaskRaw(input);
  await client.query(
    `
      INSERT INTO public.carer_tasks_cache (
        firebase_id, coadmin_uid, type, player_uid, player_username, game_name,
        normalized_game_name, amount, request_id, status, current_username,
        game_account_username, retry_pending, created_at, updated_at, pending_since,
        reset_to_pending_at, returned_to_pending_at, automation_updated_at, source,
        mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1::text, $2::text, $3::text, $4::text, $5::text, $6::text, $7::text,
        NULL, NULL, 'pending',
        NULLIF($8::text, ''), NULLIF($8::text, ''), FALSE,
        $9::timestamptz, $9::timestamptz, $9::timestamptz, NULL,
        NULL, $9::timestamptz, 'authority_player_credential', now(), NULL,
        $10::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        coadmin_uid = EXCLUDED.coadmin_uid,
        type = EXCLUDED.type,
        player_uid = EXCLUDED.player_uid,
        player_username = EXCLUDED.player_username,
        game_name = EXCLUDED.game_name,
        normalized_game_name = EXCLUDED.normalized_game_name,
        status = EXCLUDED.status,
        current_username = EXCLUDED.current_username,
        game_account_username = EXCLUDED.game_account_username,
        retry_pending = EXCLUDED.retry_pending,
        updated_at = EXCLUDED.updated_at,
        pending_since = EXCLUDED.pending_since,
        reset_to_pending_at = EXCLUDED.reset_to_pending_at,
        returned_to_pending_at = EXCLUDED.returned_to_pending_at,
        automation_updated_at = EXCLUDED.automation_updated_at,
        source = EXCLUDED.source,
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = EXCLUDED.raw_firestore_data
      WHERE public.carer_tasks_cache.deleted_at IS NULL
    `,
    [
      input.taskId,
      input.coadminUid,
      input.taskType,
      input.playerUid,
      input.playerUsername,
      input.gameName.trim(),
      normalizeGameName(input.gameName),
      cleanText(input.currentUsername),
      input.nowIso,
      JSON.stringify(raw),
    ]
  );

  console.info('[SQL_TASK_CREATED_PENDING]', {
    taskId: input.taskId,
    coadminUid: input.coadminUid,
    type: input.taskType,
    playerUid: input.playerUid,
    status: 'pending',
    gameName: input.gameName,
  });

}

async function loadCredentialCarerTaskForUpdateInTxn(
  client: PoolClient,
  taskId: string
): Promise<CredentialCarerTaskRow | null> {
  const { rows } = await client.query(
    `
      SELECT firebase_id, status, assigned_carer_uid, assigned_carer_username,
             claimed_by_uid, claimed_by_username, claimed_at, coadmin_uid, deleted_at
      FROM public.carer_tasks_cache
      WHERE firebase_id = $1
      LIMIT 1
      FOR UPDATE
    `,
    [taskId]
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) {
    return null;
  }
  return {
    firebase_id: cleanText(row.firebase_id),
    status: cleanText(row.status).toLowerCase() || 'pending',
    assigned_carer_uid: cleanText(row.assigned_carer_uid) || null,
    assigned_carer_username: cleanText(row.assigned_carer_username) || null,
    claimed_by_uid: cleanText(row.claimed_by_uid) || null,
    claimed_by_username: cleanText(row.claimed_by_username) || null,
    claimed_at: row.claimed_at ? String(row.claimed_at) : null,
    coadmin_uid: cleanText(row.coadmin_uid) || null,
    deleted_at: row.deleted_at ? String(row.deleted_at) : null,
  };
}

async function reopenTerminalCredentialCarerTaskInTxn(
  client: PoolClient,
  input: {
    taskId: string;
    coadminUid: string;
    taskType: PlayerCredentialTaskType;
    playerUid: string;
    playerUsername: string;
    gameName: string;
    currentUsername?: string | null;
    nowIso: string;
  }
) {
  const raw = buildPendingCredentialTaskRaw(input);
  await client.query(
    `
      UPDATE public.carer_tasks_cache
      SET
        coadmin_uid = $2::text,
        type = $3::text,
        player_uid = $4::text,
        player_username = $5::text,
        game_name = $6::text,
        normalized_game_name = $7::text,
        status = 'pending',
        current_username = NULLIF($8::text, ''),
        game_account_username = NULLIF($8::text, ''),
        retry_pending = FALSE,
        assigned_carer_uid = NULL,
        assigned_carer_username = NULL,
        assigned_carer = NULL,
        claimed_status = NULL,
        claimed_by_uid = NULL,
        claimed_by_username = NULL,
        claimed_at = NULL,
        started_at = NULL,
        running_at = NULL,
        expires_at = NULL,
        completed_at = NULL,
        cancelled_at = NULL,
        failed_at = NULL,
        ttl_expires_at = NULL,
        completed_by_carer_uid = NULL,
        completed_by_carer_username = NULL,
        automation_status = NULL,
        automation_job_id = NULL,
        linked_job_id = NULL,
        current_job_id = NULL,
        active_job_id = NULL,
        assigned_job_status = NULL,
        automation_error = NULL,
        error_message = NULL,
        failure_reason = NULL,
        last_heartbeat_at = NULL,
        queued_at = NULL,
        reset_to_pending_at = NULL,
        returned_to_pending_at = NULL,
        pending_since = $9::timestamptz,
        updated_at = $9::timestamptz,
        automation_updated_at = $9::timestamptz,
        is_poked = FALSE,
        poke_message = NULL,
        source = 'authority_player_credential',
        mirrored_at = now(),
        deleted_at = NULL,
        raw_firestore_data = $10::jsonb
      WHERE firebase_id = $1
    `,
    [
      input.taskId,
      input.coadminUid,
      input.taskType,
      input.playerUid,
      input.playerUsername,
      input.gameName.trim(),
      normalizeGameName(input.gameName),
      cleanText(input.currentUsername),
      input.nowIso,
      JSON.stringify(raw),
    ]
  );

  console.info('[SQL_TASK_REOPENED_PENDING]', {
    taskId: input.taskId,
    coadminUid: input.coadminUid,
    type: input.taskType,
    playerUid: input.playerUid,
    status: 'pending',
    gameName: input.gameName,
  });
}

async function emitCredentialTaskUpsertOutboxInTxn(
  client: PoolClient,
  input: {
    taskId: string;
    coadminUid: string;
    playerUid: string;
    playerUsername: string;
    taskType: PlayerCredentialTaskType;
    gameName: string;
    currentUsername?: string | null;
    nowIso: string;
  }
) {
  const outboxPayload = {
    entityId: input.taskId,
    taskId: input.taskId,
    coadminUid: input.coadminUid,
    playerUid: input.playerUid,
    playerUsername: input.playerUsername,
    status: 'pending',
    type: input.taskType,
    gameName: input.gameName.trim(),
    currentUsername: cleanText(input.currentUsername) || null,
    updatedAt: input.nowIso,
    source: 'authority',
  };
  const channel = coadminTaskLiveChannel(input.coadminUid);
  await insertLiveOutboxEventWithClient(client, {
    channel,
    eventType: 'task.upserted',
    entityType: 'carer_task',
    entityId: input.taskId,
    source: 'authority_player_credential',
    mirroredAt: input.nowIso,
    payload: outboxPayload,
  });
  console.info('[RESET_PASSWORD_TASK_OUTBOX_INSERTED]', {
    taskId: input.taskId,
    taskType: input.taskType,
    coadminUid: input.coadminUid,
    channel,
  });
  return { outboxChannels: [channel] };
}

export async function createPlayerCredentialTaskInSql(input: {
  playerUid: string;
  playerUsername?: string | null;
  gameName: string;
  taskType: PlayerCredentialTaskType;
  coadminUidHint?: string | null;
  gameLoginId?: string | null;
  idempotencyKey?: string | null;
}): Promise<{
  taskId: string;
  coadminUid: string;
  gameLoginId: string | null;
  insertedTask: boolean;
  outboxChannels: string[];
  duplicate?: boolean;
  reopened?: boolean;
  existingStatus?: string;
}> {
  const playerUid = cleanText(input.playerUid);
  const gameName = cleanText(input.gameName);
  const taskType = input.taskType;
  if (!playerUid || !gameName) {
    throw new Error('playerUid and gameName are required.');
  }
  if (taskType !== 'reset_password' && taskType !== 'recreate_username') {
    throw new Error('taskType must be reset_password or recreate_username.');
  }

  const db = getPlayerMirrorPool();
  if (!db) {
    throw new Error('SQL pool unavailable.');
  }

  const normalizedGame = normalizeGameName(gameName);
  const operationKey =
    cleanText(input.idempotencyKey) ||
    `player_credential_task:${taskType}:${playerUid}:${normalizedGame}`;

  logAuthPayloadPreTxnRemoved('create_username');

  console.info('[RESET_PASSWORD_TASK_CREATE_START]', {
    playerUid,
    gameName: gameName.trim(),
    taskType,
    gameLoginId: cleanText(input.gameLoginId) || null,
  });

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const op = await claimAuthorityOperation(client, {
      operationKey,
      operationType: 'player_credential_task',
      userUid: playerUid,
      sourceId: `${taskType}:${normalizedGame}`,
      actorUid: playerUid,
      payload: {},
    });
    if (!op.claimed && op.duplicate) {
      const payload = await readAuthorityOperationPayloadWithClient(client, operationKey, {
        flowName: 'create_username',
      });
      if (payload?.taskId) {
        const duplicateTaskId = String(payload.taskId);
        const duplicateCoadminUid = String(payload.coadminUid || '');
        const duplicateGameLoginId = payload.gameLoginId ? String(payload.gameLoginId) : null;
        const payloadOutboxChannels = Array.isArray(payload.outboxChannels)
          ? payload.outboxChannels.map(String)
          : [];
        const existingTask = await loadCredentialCarerTaskForUpdateInTxn(client, duplicateTaskId);

        if (existingTask && !existingTask.deleted_at) {
          const existingStatus = existingTask.status;

          if (ACTIVE_CREDENTIAL_TASK_STATUSES.has(existingStatus)) {
            console.info('[PLAYER_CREDENTIAL_TASK_DUPLICATE_ACTIVE]', {
              taskId: duplicateTaskId,
              playerUid,
              taskType,
              existingStatus,
            });
            await client.query('COMMIT');
            return {
              taskId: duplicateTaskId,
              coadminUid: duplicateCoadminUid,
              gameLoginId: duplicateGameLoginId,
              insertedTask: false,
              outboxChannels: payloadOutboxChannels,
              duplicate: true,
              reopened: false,
              existingStatus,
            };
          }

          if (REOPENABLE_TERMINAL_CREDENTIAL_TASK_STATUSES.has(existingStatus)) {
            const player = await loadPlayerProfileInTxn(client, playerUid);
            if (!player) {
              throw new Error('Player profile not found.');
            }
            if (player.status === 'disabled') {
              throw new Error('Your account is disabled.');
            }

            const gameLogin = await loadPlayerGameLoginInTxn(client, {
              playerUid,
              gameName,
              gameLoginId: duplicateGameLoginId || input.gameLoginId,
            });
            if (!gameLogin) {
              throw new Error('Game login not found for this game.');
            }

            const coadminUid =
              cleanText(gameLogin.coadminUid) ||
              duplicateCoadminUid ||
              cleanText(input.coadminUidHint) ||
              cleanText(player.coadminUid);
            if (!coadminUid) {
              throw new Error('Player coadmin scope not found.');
            }

            const playerUsername =
              cleanText(input.playerUsername) ||
              cleanText(gameLogin.playerUsername) ||
              player.username;
            const nowIso = new Date().toISOString();

            await reopenTerminalCredentialCarerTaskInTxn(client, {
              taskId: duplicateTaskId,
              coadminUid,
              taskType,
              playerUid,
              playerUsername,
              gameName,
              currentUsername: gameLogin.gameUsername,
              nowIso,
            });

            const { outboxChannels } = await emitCredentialTaskUpsertOutboxInTxn(client, {
              taskId: duplicateTaskId,
              coadminUid,
              playerUid,
              playerUsername,
              taskType,
              gameName,
              currentUsername: gameLogin.gameUsername,
              nowIso,
            });

            await client.query('COMMIT');

            console.info('[PLAYER_CREDENTIAL_TASK_REOPENED]', {
              taskId: duplicateTaskId,
              taskType,
              playerUid,
              coadminUid,
              previousStatus: existingStatus,
            });
            scheduleAutoClaimPendingTaskOnCreate({
              taskId: duplicateTaskId,
              coadminUid,
              trigger: `player_credential_task:${taskType}:reopen`,
            });

            return {
              taskId: duplicateTaskId,
              coadminUid,
              gameLoginId: gameLogin.id,
              insertedTask: false,
              outboxChannels,
              duplicate: true,
              reopened: true,
              existingStatus,
            };
          }

          console.info('[PLAYER_CREDENTIAL_TASK_DUPLICATE_UNCHANGED]', {
            taskId: duplicateTaskId,
            playerUid,
            taskType,
            existingStatus,
          });
          await client.query('COMMIT');
          return {
            taskId: duplicateTaskId,
            coadminUid: duplicateCoadminUid,
            gameLoginId: duplicateGameLoginId,
            insertedTask: false,
            outboxChannels: payloadOutboxChannels,
            duplicate: true,
            reopened: false,
            existingStatus,
          };
        }

        console.info('[PLAYER_CREDENTIAL_TASK_DUPLICATE_STALE_TASK]', {
          taskId: duplicateTaskId,
          playerUid,
          taskType,
          reason: existingTask ? 'deleted_task_row' : 'missing_task_row',
        });
      }
    }

    const player = await loadPlayerProfileInTxn(client, playerUid);
    if (!player) {
      throw new Error('Player profile not found.');
    }
    if (player.status === 'disabled') {
      throw new Error('Your account is disabled.');
    }

    const gameLogin = await loadPlayerGameLoginInTxn(client, {
      playerUid,
      gameName,
      gameLoginId: input.gameLoginId,
    });
    if (!gameLogin) {
      throw new Error('Game login not found for this game.');
    }

    const coadminUid =
      cleanText(gameLogin.coadminUid) ||
      cleanText(input.coadminUidHint) ||
      cleanText(player.coadminUid);
    if (!coadminUid) {
      throw new Error('Player coadmin scope not found.');
    }

    const playerUsername =
      cleanText(input.playerUsername) ||
      cleanText(gameLogin.playerUsername) ||
      player.username;
    const taskId = credentialTaskId(taskType, coadminUid, playerUid, gameName);
    const nowIso = new Date().toISOString();

    await client.query(
      `
        UPDATE public.carer_tasks_cache
        SET deleted_at = NULL
        WHERE firebase_id = $1 AND deleted_at IS NOT NULL
      `,
      [taskId]
    );

    await upsertCredentialCarerTaskInTxn(client, {
      taskId,
      coadminUid,
      taskType,
      playerUid,
      playerUsername,
      gameName,
      currentUsername: gameLogin.gameUsername,
      nowIso,
    });

    const { outboxChannels } = await emitCredentialTaskUpsertOutboxInTxn(client, {
      taskId,
      coadminUid,
      playerUid,
      playerUsername,
      taskType,
      gameName,
      currentUsername: gameLogin.gameUsername,
      nowIso,
    });

    await client.query(
      `
        UPDATE public.authority_operations
        SET payload = $2::jsonb
        WHERE operation_key = $1
      `,
      [
        operationKey,
        JSON.stringify({
          taskId,
          coadminUid,
          gameLoginId: gameLogin.id,
          outboxChannels,
        }),
      ]
    );

    await client.query('COMMIT');

    console.info('[RESET_PASSWORD_TASK_CREATED]', {
      taskId,
      taskType,
      playerUid,
      coadminUid,
      gameName: gameName.trim(),
      gameLoginId: gameLogin.id,
      status: 'pending',
      retryPending: false,
    });
    scheduleAutoClaimPendingTaskOnCreate({
      taskId,
      coadminUid,
      trigger: `player_credential_task:${taskType}`,
    });

    console.info('[PLAYER_CREDENTIAL_TASK_FLOW_AUDIT]', {
      taskId,
      taskType,
      playerUid,
      coadminUid,
      gameName: gameName.trim(),
      gameLoginId: gameLogin.id,
      requestStatus: 'pending',
      taskStatus: 'pending',
      insertedTask: true,
      outboxChannels,
      firestoreAttempted: false,
      reason: `player_${taskType}_create`,
    });

    return {
      taskId,
      coadminUid,
      gameLoginId: gameLogin.id,
      insertedTask: true,
      outboxChannels,
      duplicate: false,
      reopened: false,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
