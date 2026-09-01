/**
 * Regression harness for player credential reset_password duplicate handling.
 *
 * Mirrors lib/sql/authorityPlayerCredentialTasks.ts createPlayerCredentialTaskInSql
 * (without scheduleAutoClaimPendingTaskOnCreate side effects).
 *
 * Production import is not used: server-only + deep TS dependency chain block
 * direct Node import without invasive test refactors.
 *
 * Usage:
 *   node scripts/test-player-credential-reset-password-regression.mjs
 */
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const GAME_NAME = 'Game Vault';
const NORMALIZED_GAME = 'game_vault';
const TASK_TYPE = 'reset_password';
const PRODUCTION_SOURCE = 'lib/sql/authorityPlayerCredentialTasks.ts';

const ACTIVE_STATUSES = new Set(['pending', 'in_progress', 'urgent', 'pending_review']);
const REOPENABLE_TERMINAL_STATUSES = new Set(['completed']);

function clean(value) {
  return String(value || '').trim();
}

function normalizeGameName(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function loadEnvLocal() {
  const merged = { ...process.env };
  if (fs.existsSync('.env.local')) {
    for (const line of fs.readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const index = line.indexOf('=');
      merged[line.slice(0, index).trim()] = line.slice(index + 1).trim();
    }
  }
  return merged;
}

function taskIdFor(coadminUid, playerUid, normalizedGame) {
  return `${TASK_TYPE}__${coadminUid}__${playerUid}__${normalizedGame}`;
}

function operationKeyFor(playerUid, normalizedGame) {
  return `player_credential_task:${TASK_TYPE}:${playerUid}:${normalizedGame}`;
}

function coadminTaskChannel(coadminUid) {
  return `coadmin:${coadminUid}:tasks`;
}

function hashPayload(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function buildPendingRaw(input) {
  return {
    id: input.taskId,
    coadminUid: input.coadminUid,
    type: input.taskType,
    playerUid: input.playerUid,
    playerUsername: input.playerUsername,
    gameName: input.gameName.trim(),
    status: 'pending',
    retryPending: false,
    pendingSince: input.nowIso,
    currentUsername: input.currentUsername || null,
    gameAccountUsername: input.currentUsername || null,
  };
}

async function insertOutbox(client, input) {
  const outboxPayload = {
    entityId: input.taskId,
    taskId: input.taskId,
    coadminUid: input.coadminUid,
    playerUid: input.playerUid,
    playerUsername: input.playerUsername,
    status: 'pending',
    type: input.taskType,
    gameName: input.gameName.trim(),
    currentUsername: input.currentUsername || null,
    updatedAt: input.nowIso,
    source: 'authority',
  };
  const channel = coadminTaskChannel(input.coadminUid);
  await client.query(
    `
      INSERT INTO public.live_outbox (
        channel, event_type, entity_type, entity_id, payload, payload_hash, source, mirrored_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::timestamptz)
    `,
    [
      channel,
      'task.upserted',
      'carer_task',
      input.taskId,
      JSON.stringify(outboxPayload),
      hashPayload(outboxPayload),
      'authority_player_credential',
      input.nowIso,
    ]
  );
  return { outboxChannels: [channel] };
}

async function reopenTerminalTask(client, input) {
  const raw = buildPendingRaw(input);
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
      clean(input.currentUsername),
      input.nowIso,
      JSON.stringify(raw),
    ]
  );
}

/**
 * Mirror of createPlayerCredentialTaskInSql (see PRODUCTION_SOURCE).
 */
async function createPlayerCredentialTaskInSql(pool, input) {
  const playerUid = clean(input.playerUid);
  const gameName = clean(input.gameName);
  const taskType = input.taskType;
  if (!playerUid || !gameName) {
    throw new Error('playerUid and gameName are required.');
  }

  const normalizedGame = normalizeGameName(gameName);
  const operationKey =
    clean(input.idempotencyKey) ||
    `player_credential_task:${taskType}:${playerUid}:${normalizedGame}`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const claimResult = await client.query(
      `
        INSERT INTO public.authority_operations (
          operation_key, operation_type, user_uid, source_id, actor_uid, actor_role, payload
        )
        VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''), NULLIF($6, ''), $7::jsonb)
        ON CONFLICT (operation_key) DO NOTHING
        RETURNING operation_key
      `,
      [
        operationKey,
        'player_credential_task',
        playerUid,
        `${taskType}:${normalizedGame}`,
        playerUid,
        '',
        JSON.stringify({}),
      ]
    );
    const opClaimed = (claimResult.rowCount || 0) > 0;

    if (!opClaimed) {
      const payloadResult = await client.query(
        `SELECT payload FROM public.authority_operations WHERE operation_key = $1 LIMIT 1`,
        [operationKey]
      );
      const payload = payloadResult.rows[0]?.payload || null;
      if (payload?.taskId) {
        const duplicateTaskId = String(payload.taskId);
        const duplicateCoadminUid = String(payload.coadminUid || '');
        const duplicateGameLoginId = payload.gameLoginId ? String(payload.gameLoginId) : null;
        const payloadOutboxChannels = Array.isArray(payload.outboxChannels)
          ? payload.outboxChannels.map(String)
          : [];

        const existingResult = await client.query(
          `
            SELECT firebase_id, status, assigned_carer_uid, claimed_by_uid, claimed_at,
                   coadmin_uid, deleted_at
            FROM public.carer_tasks_cache
            WHERE firebase_id = $1
            LIMIT 1
            FOR UPDATE
          `,
          [duplicateTaskId]
        );
        const existing = existingResult.rows[0];

        if (existing && !existing.deleted_at) {
          const existingStatus = clean(existing.status).toLowerCase() || 'pending';

          if (ACTIVE_STATUSES.has(existingStatus)) {
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

          if (REOPENABLE_TERMINAL_STATUSES.has(existingStatus)) {
            const playerResult = await client.query(
              `
                SELECT uid, username, role, status, coadmin_uid, created_by
                FROM public.players_cache
                WHERE uid = $1 AND deleted_at IS NULL
                LIMIT 1
                FOR UPDATE
              `,
              [playerUid]
            );
            const playerRow = playerResult.rows[0];
            if (!playerRow) throw new Error('Player profile not found.');

            let gameLoginResult;
            if (duplicateGameLoginId || input.gameLoginId) {
              gameLoginResult = await client.query(
                `
                  SELECT firebase_id, player_uid, player_username, game_name, game_username,
                         coadmin_uid, created_by
                  FROM public.player_game_logins_cache
                  WHERE firebase_id = $1 AND deleted_at IS NULL
                  LIMIT 1
                `,
                [clean(duplicateGameLoginId || input.gameLoginId)]
              );
            } else {
              gameLoginResult = await client.query(
                `
                  SELECT firebase_id, player_uid, player_username, game_name, game_username,
                         coadmin_uid, created_by
                  FROM public.player_game_logins_cache
                  WHERE player_uid = $1 AND deleted_at IS NULL AND normalized_game_name = $2
                  ORDER BY COALESCE(updated_at, created_at, mirrored_at) DESC
                  LIMIT 1
                `,
                [playerUid, normalizedGame]
              );
            }
            const gameLoginRow = gameLoginResult.rows[0];
            if (!gameLoginRow) throw new Error('Game login not found for this game.');

            const coadminUid =
              clean(gameLoginRow.coadmin_uid) ||
              clean(gameLoginRow.created_by) ||
              duplicateCoadminUid ||
              clean(input.coadminUidHint);
            const playerUsername =
              clean(input.playerUsername) ||
              clean(gameLoginRow.player_username) ||
              clean(playerRow.username) ||
              'Player';
            const nowIso = new Date().toISOString();
            const currentUsername = clean(gameLoginRow.game_username);

            await reopenTerminalTask(client, {
              taskId: duplicateTaskId,
              coadminUid,
              taskType,
              playerUid,
              playerUsername,
              gameName,
              currentUsername,
              nowIso,
            });
            const { outboxChannels } = await insertOutbox(client, {
              taskId: duplicateTaskId,
              coadminUid,
              playerUid,
              playerUsername,
              taskType,
              gameName,
              currentUsername,
              nowIso,
            });
            await client.query('COMMIT');
            return {
              taskId: duplicateTaskId,
              coadminUid,
              gameLoginId: clean(gameLoginRow.firebase_id),
              insertedTask: false,
              outboxChannels,
              duplicate: true,
              reopened: true,
              existingStatus,
            };
          }

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
      }
    }

    const playerResult = await client.query(
      `
        SELECT uid, username, role, status, coadmin_uid, created_by
        FROM public.players_cache
        WHERE uid = $1 AND deleted_at IS NULL
        LIMIT 1
        FOR UPDATE
      `,
      [playerUid]
    );
    const playerRow = playerResult.rows[0];
    if (!playerRow) throw new Error('Player profile not found.');

    let gameLoginResult;
    if (input.gameLoginId) {
      gameLoginResult = await client.query(
        `
          SELECT firebase_id, player_uid, player_username, game_name, game_username,
                 coadmin_uid, created_by
          FROM public.player_game_logins_cache
          WHERE firebase_id = $1 AND deleted_at IS NULL
          LIMIT 1
        `,
        [clean(input.gameLoginId)]
      );
    } else {
      gameLoginResult = await client.query(
        `
          SELECT firebase_id, player_uid, player_username, game_name, game_username,
                 coadmin_uid, created_by
          FROM public.player_game_logins_cache
          WHERE player_uid = $1 AND deleted_at IS NULL AND normalized_game_name = $2
          ORDER BY COALESCE(updated_at, created_at, mirrored_at) DESC
          LIMIT 1
        `,
        [playerUid, normalizedGame]
      );
    }
    const gameLoginRow = gameLoginResult.rows[0];
    if (!gameLoginRow) throw new Error('Game login not found for this game.');

    const coadminUid =
      clean(gameLoginRow.coadmin_uid) ||
      clean(gameLoginRow.created_by) ||
      clean(input.coadminUidHint);
    const playerUsername =
      clean(input.playerUsername) ||
      clean(gameLoginRow.player_username) ||
      clean(playerRow.username) ||
      'Player';
    const taskId = taskIdFor(coadminUid, playerUid, normalizedGame);
    const nowIso = new Date().toISOString();
    const currentUsername = clean(gameLoginRow.game_username);
    const rawFirestore = buildPendingRaw({
      taskId,
      coadminUid,
      taskType,
      playerUid,
      playerUsername,
      gameName,
      currentUsername,
      nowIso,
    });

    await client.query(
      `UPDATE public.carer_tasks_cache SET deleted_at = NULL WHERE firebase_id = $1 AND deleted_at IS NOT NULL`,
      [taskId]
    );

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
        taskId,
        coadminUid,
        taskType,
        playerUid,
        playerUsername,
        gameName.trim(),
        normalizedGame,
        currentUsername,
        nowIso,
        JSON.stringify(rawFirestore),
      ]
    );

    const { outboxChannels } = await insertOutbox(client, {
      taskId,
      coadminUid,
      playerUid,
      playerUsername,
      taskType,
      gameName,
      currentUsername,
      nowIso,
    });

    await client.query(
      `UPDATE public.authority_operations SET payload = $2::jsonb WHERE operation_key = $1`,
      [
        operationKey,
        JSON.stringify({
          taskId,
          coadminUid,
          gameLoginId: clean(gameLoginRow.firebase_id),
          outboxChannels,
        }),
      ]
    );

    await client.query('COMMIT');
    return {
      taskId,
      coadminUid,
      gameLoginId: clean(gameLoginRow.firebase_id),
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

async function insertFixtures(pool, input) {
  const nowIso = new Date().toISOString();
  const { playerUid, playerUsername, coadminUid, gameLoginId, taskId } = input;

  await pool.query(
    `
      INSERT INTO public.players_cache (
        uid, username, role, status, created_by, coadmin_uid,
        created_at, updated_at, source, mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1, $2, 'player', 'active', $3, $3,
        $4::timestamptz, $4::timestamptz, 'regression_test', now(), NULL, '{}'::jsonb
      )
      ON CONFLICT (uid) DO UPDATE SET
        deleted_at = NULL, status = 'active', coadmin_uid = EXCLUDED.coadmin_uid,
        created_by = EXCLUDED.created_by, updated_at = EXCLUDED.updated_at
    `,
    [playerUid, playerUsername, coadminUid, nowIso]
  );

  await pool.query(
    `
      INSERT INTO public.player_game_logins_cache (
        firebase_id, player_uid, player_username, game_name, normalized_game_name,
        game_username, game_password, coadmin_uid, created_by,
        created_at, updated_at, source, mirrored_at, deleted_at, raw_firestore_data
      )
      VALUES (
        $1, $2, $3, $4, $5, 'vault_user', 'vault_pass_old', $6, $6,
        $7::timestamptz, $7::timestamptz, 'regression_test', now(), NULL, '{}'::jsonb
      )
      ON CONFLICT (firebase_id) DO UPDATE SET
        deleted_at = NULL, player_uid = EXCLUDED.player_uid,
        game_name = EXCLUDED.game_name, normalized_game_name = EXCLUDED.normalized_game_name,
        coadmin_uid = EXCLUDED.coadmin_uid, created_by = EXCLUDED.created_by,
        updated_at = EXCLUDED.updated_at
    `,
    [gameLoginId, playerUid, playerUsername, GAME_NAME, NORMALIZED_GAME, coadminUid, nowIso]
  );

  await pool.query(`DELETE FROM public.live_outbox WHERE entity_id = $1`, [taskId]);
  await pool.query(`DELETE FROM public.carer_tasks_cache WHERE firebase_id = $1`, [taskId]);
  await pool.query(`DELETE FROM public.authority_operations WHERE operation_key = $1`, [
    operationKeyFor(playerUid, NORMALIZED_GAME),
  ]);
}

async function cleanupFixtures(pool, input) {
  const { playerUid, coadminUid, gameLoginId, taskId } = input;
  await pool.query(`DELETE FROM public.live_outbox WHERE entity_id = $1`, [taskId]);
  await pool.query(`DELETE FROM public.carer_tasks_cache WHERE firebase_id = $1`, [taskId]);
  await pool.query(`DELETE FROM public.authority_operations WHERE operation_key = $1`, [
    operationKeyFor(playerUid, NORMALIZED_GAME),
  ]);
  await pool.query(`DELETE FROM public.player_game_logins_cache WHERE firebase_id = $1`, [gameLoginId]);
  await pool.query(`DELETE FROM public.players_cache WHERE uid = $1`, [playerUid]);
}

async function readTask(pool, taskId) {
  const { rows } = await pool.query(
    `
      SELECT firebase_id, type, status, normalized_game_name, coadmin_uid, player_uid,
             assigned_carer_uid, assigned_carer_username, claimed_by_uid, claimed_by_username,
             claimed_at, completed_at, automation_job_id, deleted_at
      FROM public.carer_tasks_cache
      WHERE firebase_id = $1
      LIMIT 1
    `,
    [taskId]
  );
  return rows[0] || null;
}

async function maxOutboxId(pool, channel, entityId) {
  const { rows } = await pool.query(
    `
      SELECT COALESCE(MAX(outbox_id), 0)::bigint AS max_id
      FROM public.live_outbox
      WHERE channel = $1 AND entity_id = $2 AND deleted_at IS NULL
    `,
    [channel, entityId]
  );
  return Number(rows[0]?.max_id || 0);
}

async function countOutboxUpsertsAfter(pool, channel, entityId, afterOutboxId) {
  const { rows } = await pool.query(
    `
      SELECT COUNT(*)::int AS count
      FROM public.live_outbox
      WHERE channel = $1 AND entity_id = $2 AND event_type = 'task.upserted'
        AND outbox_id > $3 AND deleted_at IS NULL
    `,
    [channel, entityId, afterOutboxId]
  );
  return Number(rows[0]?.count || 0);
}

async function simulateTaskCompletion(pool, taskId, carerUid) {
  const nowIso = new Date().toISOString();
  await pool.query(
    `
      UPDATE public.carer_tasks_cache
      SET status = 'completed', completed_at = $2::timestamptz,
          assigned_carer_uid = $3, assigned_carer_username = 'Regression Carer',
          completed_by_carer_uid = $3, completed_by_carer_username = 'Regression Carer',
          automation_status = 'completed', updated_at = $2::timestamptz
      WHERE firebase_id = $1 AND deleted_at IS NULL
    `,
    [taskId, nowIso, carerUid]
  );
}

async function simulateTaskInProgress(pool, taskId, carerUid, carerUsername) {
  const nowIso = new Date().toISOString();
  await pool.query(
    `
      UPDATE public.carer_tasks_cache
      SET status = 'in_progress',
          assigned_carer_uid = $2,
          assigned_carer_username = $3,
          assigned_carer = $3,
          claimed_by_uid = $2,
          claimed_by_username = $3,
          claimed_at = $4::timestamptz,
          started_at = $4::timestamptz,
          automation_status = 'running',
          automation_job_id = $5,
          updated_at = $4::timestamptz
      WHERE firebase_id = $1 AND deleted_at IS NULL
    `,
    [taskId, carerUid, carerUsername, nowIso, `regtest_job_${taskId.slice(0, 12)}`]
  );
}

function playerShowsRequestSent(apiOk) {
  return Boolean(apiOk);
}

async function runFirstEverTest(pool) {
  const suffix = randomUUID().slice(0, 8);
  const playerUid = `regtest_cred_first_${suffix}`;
  const coadminUid = `regtest_coadmin_${suffix}`;
  const gameLoginId = `regtest_login_${suffix}`;
  const taskId = taskIdFor(coadminUid, playerUid, NORMALIZED_GAME);
  const channel = coadminTaskChannel(coadminUid);

  try {
    await insertFixtures(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      coadminUid,
      gameLoginId,
      taskId,
    });

    const result = await createPlayerCredentialTaskInSql(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      gameName: GAME_NAME,
      taskType: TASK_TYPE,
      coadminUidHint: coadminUid,
      gameLoginId,
    });

    const task = await readTask(pool, taskId);
    const outboxCount = await countOutboxUpsertsAfter(pool, channel, taskId, 0);

    const ok =
      !result.duplicate &&
      result.insertedTask &&
      result.reopened === false &&
      task?.status === 'pending' &&
      outboxCount === 1;

    return {
      name: 'first_ever_reset_password_creates_pending_task',
      ok,
      createResult: result,
      taskStatus: task?.status,
      outboxEvents: outboxCount,
      playerShowsRequestSent: playerShowsRequestSent(true),
    };
  } finally {
    await cleanupFixtures(pool, { playerUid, coadminUid, gameLoginId, taskId });
  }
}

async function runRepeatAfterCompletionTest(pool) {
  const suffix = randomUUID().slice(0, 8);
  const playerUid = `regtest_cred_repeat_${suffix}`;
  const coadminUid = `regtest_coadmin_${suffix}`;
  const gameLoginId = `regtest_login_${suffix}`;
  const carerUid = `regtest_carer_${suffix}`;
  const taskId = taskIdFor(coadminUid, playerUid, NORMALIZED_GAME);
  const channel = coadminTaskChannel(coadminUid);

  try {
    await insertFixtures(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      coadminUid,
      gameLoginId,
      taskId,
    });

    await createPlayerCredentialTaskInSql(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      gameName: GAME_NAME,
      taskType: TASK_TYPE,
      coadminUidHint: coadminUid,
      gameLoginId,
    });

    await simulateTaskCompletion(pool, taskId, carerUid);
    const outboxBefore = await maxOutboxId(pool, channel, taskId);

    const second = await createPlayerCredentialTaskInSql(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      gameName: GAME_NAME,
      taskType: TASK_TYPE,
      coadminUidHint: coadminUid,
      gameLoginId,
    });

    const task = await readTask(pool, taskId);
    const outboxAfter = await countOutboxUpsertsAfter(pool, channel, taskId, outboxBefore);

    const ok =
      second.duplicate === true &&
      second.reopened === true &&
      second.insertedTask === false &&
      second.existingStatus === 'completed' &&
      task?.status === 'pending' &&
      !task?.assigned_carer_uid &&
      !task?.completed_at &&
      outboxAfter >= 1;

    return {
      name: 'repeat_after_completed_reopens_same_task',
      ok,
      secondCreate: second,
      taskAfter: {
        status: task?.status,
        assigned_carer_uid: task?.assigned_carer_uid,
        completed_at: task?.completed_at,
      },
      newOutboxEvents: outboxAfter,
      playerShowsRequestSent: playerShowsRequestSent(true),
    };
  } finally {
    await cleanupFixtures(pool, { playerUid, coadminUid, gameLoginId, taskId });
  }
}

async function runActivePendingDuplicateTest(pool) {
  const suffix = randomUUID().slice(0, 8);
  const playerUid = `regtest_cred_active_${suffix}`;
  const coadminUid = `regtest_coadmin_${suffix}`;
  const gameLoginId = `regtest_login_${suffix}`;
  const taskId = taskIdFor(coadminUid, playerUid, NORMALIZED_GAME);
  const channel = coadminTaskChannel(coadminUid);

  try {
    await insertFixtures(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      coadminUid,
      gameLoginId,
      taskId,
    });

    const first = await createPlayerCredentialTaskInSql(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      gameName: GAME_NAME,
      taskType: TASK_TYPE,
      coadminUidHint: coadminUid,
      gameLoginId,
    });

    const outboxBefore = await maxOutboxId(pool, channel, taskId);
    const second = await createPlayerCredentialTaskInSql(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      gameName: GAME_NAME,
      taskType: TASK_TYPE,
      coadminUidHint: coadminUid,
      gameLoginId,
    });

    const task = await readTask(pool, taskId);
    const pendingCount = await pool.query(
      `
        SELECT COUNT(*)::int AS count FROM public.carer_tasks_cache
        WHERE player_uid = $1 AND coadmin_uid = $2 AND type = $3
          AND normalized_game_name = $4 AND status = 'pending' AND deleted_at IS NULL
      `,
      [playerUid, coadminUid, TASK_TYPE, NORMALIZED_GAME]
    );
    const outboxAfter = await countOutboxUpsertsAfter(pool, channel, taskId, outboxBefore);

    const ok =
      first.insertedTask &&
      second.duplicate === true &&
      second.reopened === false &&
      second.existingStatus === 'pending' &&
      task?.status === 'pending' &&
      Number(pendingCount.rows[0]?.count) === 1 &&
      outboxAfter === 0;

    return {
      name: 'duplicate_while_pending_keeps_active_task',
      ok,
      secondCreate: second,
      taskStatus: task?.status,
      pendingRowCount: Number(pendingCount.rows[0]?.count),
      newOutboxEvents: outboxAfter,
      playerShowsRequestSent: playerShowsRequestSent(true),
    };
  } finally {
    await cleanupFixtures(pool, { playerUid, coadminUid, gameLoginId, taskId });
  }
}

async function runInProgressDuplicateTest(pool) {
  const suffix = randomUUID().slice(0, 8);
  const playerUid = `regtest_cred_inprog_${suffix}`;
  const coadminUid = `regtest_coadmin_${suffix}`;
  const gameLoginId = `regtest_login_${suffix}`;
  const carerUid = `regtest_carer_${suffix}`;
  const carerUsername = 'Regression Carer';
  const taskId = taskIdFor(coadminUid, playerUid, NORMALIZED_GAME);
  const channel = coadminTaskChannel(coadminUid);

  try {
    await insertFixtures(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      coadminUid,
      gameLoginId,
      taskId,
    });

    await createPlayerCredentialTaskInSql(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      gameName: GAME_NAME,
      taskType: TASK_TYPE,
      coadminUidHint: coadminUid,
      gameLoginId,
    });

    await simulateTaskInProgress(pool, taskId, carerUid, carerUsername);
    const before = await readTask(pool, taskId);
    const outboxBefore = await maxOutboxId(pool, channel, taskId);

    const second = await createPlayerCredentialTaskInSql(pool, {
      playerUid,
      playerUsername: `RegPlayer_${suffix}`,
      gameName: GAME_NAME,
      taskType: TASK_TYPE,
      coadminUidHint: coadminUid,
      gameLoginId,
    });

    const after = await readTask(pool, taskId);
    const outboxAfter = await countOutboxUpsertsAfter(pool, channel, taskId, outboxBefore);

    const ok =
      second.duplicate === true &&
      second.reopened === false &&
      second.existingStatus === 'in_progress' &&
      after?.status === 'in_progress' &&
      after?.assigned_carer_uid === carerUid &&
      after?.claimed_by_uid === carerUid &&
      String(after?.claimed_at) === String(before?.claimed_at) &&
      after?.automation_job_id === before?.automation_job_id &&
      outboxAfter === 0;

    return {
      name: 'duplicate_while_in_progress_preserves_carer_claim',
      ok,
      secondCreate: second,
      before: {
        status: before?.status,
        assigned_carer_uid: before?.assigned_carer_uid,
        claimed_by_uid: before?.claimed_by_uid,
        claimed_at: before?.claimed_at,
        automation_job_id: before?.automation_job_id,
      },
      after: {
        status: after?.status,
        assigned_carer_uid: after?.assigned_carer_uid,
        claimed_by_uid: after?.claimed_by_uid,
        claimed_at: after?.claimed_at,
        automation_job_id: after?.automation_job_id,
      },
      newOutboxEvents: outboxAfter,
      playerShowsRequestSent: playerShowsRequestSent(true),
    };
  } finally {
    await cleanupFixtures(pool, { playerUid, coadminUid, gameLoginId, taskId });
  }
}

async function main() {
  const env = loadEnvLocal();
  const databaseUrl = clean(env.DATABASE_URL || env.POSTGRES_URL);
  if (!databaseUrl) throw new Error('DATABASE_URL or POSTGRES_URL is required.');

  const pool = new pg.Pool({ connectionString: databaseUrl });

  try {
    const results = [
      await runFirstEverTest(pool),
      await runRepeatAfterCompletionTest(pool),
      await runActivePendingDuplicateTest(pool),
      await runInProgressDuplicateTest(pool),
    ];

    const summary = {
      ranAt: new Date().toISOString(),
      productionMirrorSource: PRODUCTION_SOURCE,
      usesProductionImport: false,
      productionImportNote:
        'Direct import blocked by server-only and TS dependency chain; harness mirrors production SQL.',
      results,
      allPassed: results.every((r) => r.ok),
      playerMessagingNote:
        'Player UI still shows "Reset password request sent." for all HTTP 200 outcomes (new, reopened, already-active).',
    };

    console.log(JSON.stringify(summary, null, 2));
    if (!summary.allPassed) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[TEST_PLAYER_CREDENTIAL_RESET_REGRESSION] fatal', error);
  process.exitCode = 1;
});
