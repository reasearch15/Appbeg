import 'server-only';

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';

import { isLiveVerboseLogs, SNAPSHOT_SLOW_MS } from '@/lib/server/verboseLogs';
import {
  cleanText,
  createPlayerMirrorSqlTiming,
  getPlayerMirrorPool,
  runMirrorClientQuery,
  runMirrorPoolQuery,
  type PlayerMirrorAcquireContext,
  type PlayerMirrorSqlTiming,
  toIsoString,
} from '@/lib/sql/playerMirrorCommon';

const LIVE_OUTBOX_DEDUPE_WINDOW_MS = 5_000;

export type LiveOutboxRow = {
  outbox_id: number;
  channel: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  payload_hash: string | null;
  source: string;
  mirrored_at: string | null;
  created_at: string;
};

export type PlayerRequestOutboxPayload = {
  entityId: string;
  playerUid: string;
  type: string;
  status: string;
  gameName: string;
  amount: number | null;
  baseAmount: number | null;
  automationStatus: string | null;
  playerMessage: string | null;
  retryAttempt: number | null;
  pokeMessage: string | null;
  updatedAt: string | null;
  mirroredAt: string | null;
  source: string;
};

function hashPayload(payload: Record<string, unknown>) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function playerRequestLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:requests`;
}

export function playerFreeplayLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:freeplay`;
}

export function playerTransferLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:transfer`;
}

export function playerCashoutLiveChannel(playerUid: string) {
  return `player:${cleanText(playerUid)}:cashouts`;
}

export function coadminCashoutLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:cashouts`;
}

export function carerTaskLiveChannel(carerUid: string) {
  return `carer:${cleanText(carerUid)}:tasks`;
}

export function coadminTaskLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:tasks`;
}

export function carerJobLiveChannel(carerUid: string) {
  return `carer:${cleanText(carerUid)}:jobs`;
}

export function coadminJobLiveChannel(coadminUid: string) {
  return `coadmin:${cleanText(coadminUid)}:jobs`;
}

export function agentJobLiveChannel(carerUid: string, agentId: string) {
  return `agent:${cleanText(carerUid)}:${cleanText(agentId)}:jobs`;
}

export function userChatLiveChannel(uid: string) {
  return `user:${cleanText(uid)}:chat`;
}

export type ChatMessageOutboxPayload = {
  entityId: string;
  messageId: string;
  conversationId: string;
  senderUid: string;
  receiverUid: string;
  playerUid: string;
  coadminUid: string | null;
  type: string;
  status: string;
  text: string | null;
  imageUrl: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  source: string;
};

export type CarerTaskOutboxPayload = {
  entityId: string;
  taskId: string;
  coadminUid: string;
  playerUid: string;
  type: string;
  status: string;
  automationStatus: string | null;
  gameName: string;
  amount: number | null;
  requestId: string | null;
  updatedAt: string | null;
  mirroredAt: string | null;
  source: string;
};

export async function insertLiveOutboxEvent(input: {
  channel: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  source?: string;
  mirroredAt?: string | null;
}) {
  const db = getPlayerMirrorPool();
  const channel = cleanText(input.channel);
  const entityId = cleanText(input.entityId);
  if (!db || !channel || !entityId) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'database_or_input_missing', channel, entityId });
    return null;
  }

  const payloadHash = hashPayload(input.payload);

  try {
    const duplicate = await db.query(
      `
        SELECT 1
        FROM public.live_outbox
        WHERE channel = $1
          AND entity_id = $2
          AND payload_hash = $3
          AND deleted_at IS NULL
          AND created_at > NOW() - INTERVAL '5 seconds'
        LIMIT 1
      `,
      [channel, entityId, payloadHash]
    );
    if (duplicate.rowCount && duplicate.rowCount > 0) {
      console.info('[LIVE_OUTBOX] skipped duplicate', {
        channel,
        entityId,
        eventType: input.eventType,
      });
      if (cleanText(input.entityType) === 'carer_task') {
        console.info('[LIVE_STREAM_EVENT_SKIPPED]', {
          reason: 'duplicate_outbox',
          channel,
          entityId,
          eventType: input.eventType,
        });
      }
      return null;
    }

    const result = await db.query(
      `
        INSERT INTO public.live_outbox (
          channel,
          event_type,
          entity_type,
          entity_id,
          payload,
          payload_hash,
          source,
          mirrored_at
        )
        VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::timestamptz)
        RETURNING outbox_id
      `,
      [
        channel,
        cleanText(input.eventType),
        cleanText(input.entityType),
        entityId,
        JSON.stringify(input.payload),
        payloadHash,
        cleanText(input.source) || 'mirror',
        input.mirroredAt || null,
      ]
    );

    const outboxId = Number(result.rows[0]?.outbox_id || 0);
    const entityType = cleanText(input.entityType);
    console.info('[LIVE_OUTBOX] inserted', {
      outboxId,
      channel,
      entityId,
      eventType: input.eventType,
      entityType,
    });
    if (entityType === 'carer_task') {
      const payload = input.payload || {};
      console.info('[LIVE_OUTBOX_INSERT_TASK]', {
        outboxId,
        channel,
        eventType: cleanText(input.eventType),
        entityId,
        coadminUid: cleanText(payload.coadminUid),
        carerUid:
          cleanText(payload.assignedCarerUid) ||
          cleanText(payload.claimedByUid) ||
          cleanText(payload.carerUid),
        taskStatus: cleanText(payload.status),
        taskType: cleanText(payload.type),
      });
    }
    return outboxId;
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', {
      channel,
      entityId,
      eventType: input.eventType,
      error,
    });
    return null;
  }
}

export type LiveOutboxInsertInput = {
  channel: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  source?: string;
  mirroredAt?: string | null;
};

type NormalizedLiveOutboxInsert = {
  channel: string;
  eventType: string;
  entityType: string;
  entityId: string;
  payloadJson: string;
  payloadHash: string;
  source: string;
  mirroredAt: string | null;
};

function normalizeLiveOutboxInsert(input: LiveOutboxInsertInput): NormalizedLiveOutboxInsert | null {
  const channel = cleanText(input.channel);
  const entityId = cleanText(input.entityId);
  if (!channel || !entityId) {
    return null;
  }
  const payload = input.payload || {};
  return {
    channel,
    eventType: cleanText(input.eventType),
    entityType: cleanText(input.entityType),
    entityId,
    payloadJson: JSON.stringify(payload),
    payloadHash: hashPayload(payload),
    source: cleanText(input.source) || 'authority',
    mirroredAt: input.mirroredAt || null,
  };
}

function logLiveOutboxCarerTaskInsert(
  outboxId: number | null,
  input: LiveOutboxInsertInput
) {
  if (!outboxId || cleanText(input.entityType) !== 'carer_task') {
    return;
  }
  const payload = input.payload || {};
  console.info('[LIVE_OUTBOX_INSERT_TASK]', {
    outboxId,
    channel: cleanText(input.channel),
    eventType: cleanText(input.eventType),
    entityId: cleanText(input.entityId),
    coadminUid: cleanText(payload.coadminUid),
    carerUid:
      cleanText(payload.assignedCarerUid) ||
      cleanText(payload.claimedByUid) ||
      cleanText(payload.carerUid),
    taskStatus: cleanText(payload.status),
    taskType: cleanText(payload.type),
  });
}

export async function insertLiveOutboxEventsBatch(
  client: PoolClient,
  rows: LiveOutboxInsertInput[],
  options?: { flowName?: string }
): Promise<(number | null)[]> {
  if (!rows.length) {
    return [];
  }

  const startedAt = Date.now();
  const normalized: NormalizedLiveOutboxInsert[] = [];
  const sourceRows: LiveOutboxInsertInput[] = [];
  for (const row of rows) {
    const next = normalizeLiveOutboxInsert(row);
    if (!next) {
      continue;
    }
    normalized.push(next);
    sourceRows.push(row);
  }
  if (!normalized.length) {
    return [];
  }

  const params: unknown[] = [];
  const valueClauses: string[] = [];
  let paramIndex = 1;
  for (const row of normalized) {
    valueClauses.push(
      `($${paramIndex}, $${paramIndex + 1}, $${paramIndex + 2}, $${paramIndex + 3}, $${paramIndex + 4}::jsonb, $${paramIndex + 5}, $${paramIndex + 6}, $${paramIndex + 7}::timestamptz)`
    );
    params.push(
      row.channel,
      row.eventType,
      row.entityType,
      row.entityId,
      row.payloadJson,
      row.payloadHash,
      row.source,
      row.mirroredAt
    );
    paramIndex += 8;
  }

  const result = await client.query(
    `
      INSERT INTO public.live_outbox (
        channel,
        event_type,
        entity_type,
        entity_id,
        payload,
        payload_hash,
        source,
        mirrored_at
      )
      VALUES ${valueClauses.join(', ')}
      RETURNING outbox_id
    `,
    params
  );

  const outboxIds = result.rows.map((row) => Number(row.outbox_id) || null);
  for (let index = 0; index < outboxIds.length; index += 1) {
    logLiveOutboxCarerTaskInsert(outboxIds[index], sourceRows[index]);
  }

  if (options?.flowName) {
    console.info('[OUTBOX_BATCH_WRITE]', {
      flowName: options.flowName,
      rows: normalized.length,
      statementsBefore: normalized.length,
      statementsAfter: 1,
      roundTripsSaved: Math.max(0, normalized.length - 1),
      durationMs: Date.now() - startedAt,
    });
  }

  return outboxIds;
}

export async function insertLiveOutboxEventWithClient(
  client: PoolClient,
  input: {
    channel: string;
    eventType: string;
    entityType: string;
    entityId: string;
    payload: Record<string, unknown>;
    source?: string;
    mirroredAt?: string | null;
  }
): Promise<number | null> {
  const outboxIds = await insertLiveOutboxEventsBatch(client, [input]);
  return outboxIds[0] ?? null;
}

export function buildPlayerRequestOutboxPayload(input: {
  firebaseId: string;
  playerUid: string;
  type?: unknown;
  status?: unknown;
  gameName?: unknown;
  amount?: unknown;
  baseAmount?: unknown;
  automationStatus?: unknown;
  playerMessage?: unknown;
  retryAttempt?: unknown;
  pokeMessage?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
}): PlayerRequestOutboxPayload {
  return {
    entityId: cleanText(input.firebaseId),
    playerUid: cleanText(input.playerUid),
    type: cleanText(input.type),
    status: cleanText(input.status),
    gameName: cleanText(input.gameName),
    amount: Number.isFinite(Number(input.amount)) ? Number(input.amount) : null,
    baseAmount: Number.isFinite(Number(input.baseAmount)) ? Number(input.baseAmount) : null,
    automationStatus: cleanText(input.automationStatus) || null,
    playerMessage: cleanText(input.playerMessage) || null,
    retryAttempt: Number.isFinite(Number(input.retryAttempt)) ? Number(input.retryAttempt) : null,
    pokeMessage: cleanText(input.pokeMessage) || null,
    updatedAt: toIsoString(input.updatedAt),
    mirroredAt: toIsoString(input.mirroredAt) || new Date().toISOString(),
    source: cleanText(input.source) || 'mirror',
  };
}

export function buildCarerTaskOutboxPayload(input: {
  firebaseId: string;
  coadminUid?: unknown;
  playerUid?: unknown;
  type?: unknown;
  status?: unknown;
  automationStatus?: unknown;
  gameName?: unknown;
  amount?: unknown;
  requestId?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
}): CarerTaskOutboxPayload {
  const entityId = cleanText(input.firebaseId);
  return {
    entityId,
    taskId: entityId,
    coadminUid: cleanText(input.coadminUid),
    playerUid: cleanText(input.playerUid),
    type: cleanText(input.type),
    status: cleanText(input.status),
    automationStatus: cleanText(input.automationStatus) || null,
    gameName: cleanText(input.gameName),
    amount: Number.isFinite(Number(input.amount)) ? Number(input.amount) : null,
    requestId: cleanText(input.requestId) || null,
    updatedAt: toIsoString(input.updatedAt),
    mirroredAt: toIsoString(input.mirroredAt) || new Date().toISOString(),
    source: cleanText(input.source) || 'mirror',
  };
}

export async function emitChatMessageOutboxEvent(
  client: PoolClient,
  input: {
    entityId: string;
    conversationId: string;
    senderUid: string;
    receiverUid: string;
    type: string;
    text?: string | null;
    imageUrl?: string | null;
    updatedAt?: string | null;
    source?: string;
    participantUids: string[];
    playerUid?: string | null;
    coadminUid?: string | null;
  }
) {
  const nowIso = input.updatedAt || new Date().toISOString();
  const senderUid = cleanText(input.senderUid);
  const receiverUid = cleanText(input.receiverUid);
  const playerUid = cleanText(input.playerUid) || (senderUid || receiverUid);
  const payload: ChatMessageOutboxPayload = {
    entityId: cleanText(input.entityId),
    messageId: cleanText(input.entityId),
    conversationId: cleanText(input.conversationId),
    senderUid,
    receiverUid,
    playerUid,
    coadminUid: cleanText(input.coadminUid) || null,
    type: cleanText(input.type) || 'text',
    status: 'open',
    text: cleanText(input.text) || null,
    imageUrl: cleanText(input.imageUrl) || null,
    createdAt: nowIso,
    updatedAt: nowIso,
    source: cleanText(input.source) || 'authority_chat',
  };

  for (const uid of input.participantUids) {
    const cleanUid = cleanText(uid);
    if (!cleanUid) {
      continue;
    }
    await insertLiveOutboxEventWithClient(client, {
      channel: userChatLiveChannel(cleanUid),
      eventType: 'player_message_created',
      entityType: 'chat_message',
      entityId: payload.entityId,
      payload: payload as unknown as Record<string, unknown>,
      source: payload.source,
      mirroredAt: payload.updatedAt,
    });
    await insertLiveOutboxEventWithClient(client, {
      channel: userChatLiveChannel(cleanUid),
      eventType: 'chat_message_created',
      entityType: 'chat_message',
      entityId: payload.entityId,
      payload: payload as unknown as Record<string, unknown>,
      source: payload.source,
      mirroredAt: payload.updatedAt,
    });
    console.info('[MESSAGE_LIVE_EVENT_INSERTED]', {
      channel: userChatLiveChannel(cleanUid),
      eventTypes: ['player_message_created', 'chat_message_created'],
      messageId: payload.messageId,
      playerUid: payload.playerUid,
      coadminUid: payload.coadminUid,
      type: payload.type,
      status: payload.status,
    });
  }
}

export async function emitPlayerFriendLinkOutboxEvent(
  client: PoolClient,
  input: {
    linkId: string;
    participantUids: string[];
    requestedByUid: string;
    actorUid: string;
    status: string;
    eventType:
      | 'player_friend_request_created'
      | 'player_friend_request_accepted'
      | 'player_friend_request_declined'
      | 'player_friend_request_cancelled';
  }
) {
  const linkId = cleanText(input.linkId);
  const participantUids = Array.from(
    new Set(input.participantUids.map(cleanText).filter(Boolean))
  );
  if (!linkId || participantUids.length !== 2) {
    return [];
  }
  const updatedAt = new Date().toISOString();
  const payload = {
    entityId: linkId,
    linkId,
    participantUids,
    requestedByUid: cleanText(input.requestedByUid),
    actorUid: cleanText(input.actorUid),
    status: cleanText(input.status),
    updatedAt,
    source: 'player_friend_links',
  };
  return insertLiveOutboxEventsBatch(
    client,
    participantUids.map((uid) => ({
      channel: userChatLiveChannel(uid),
      eventType: input.eventType,
      entityType: 'player_friend_link',
      entityId: linkId,
      payload,
      source: 'player_friend_links',
      mirroredAt: updatedAt,
    })),
    { flowName: input.eventType }
  );
}

function resolveCarerTaskOutboxChannels(input: {
  coadminUid?: unknown;
  assignedCarerUid?: unknown;
  claimedByUid?: unknown;
  status?: unknown;
}) {
  const channels = new Set<string>();
  const assignedCarerUid = cleanText(input.assignedCarerUid);
  const claimedByUid = cleanText(input.claimedByUid);
  const carerUid = assignedCarerUid || claimedByUid;
  const status = cleanText(input.status).toLowerCase();
  const coadminUid = cleanText(input.coadminUid);

  if (carerUid) {
    channels.add(carerTaskLiveChannel(carerUid));
  } else if (coadminUid && (status === 'pending' || status === 'urgent')) {
    // Shadow phase: unassigned pool tasks fan out via coadmin channel only.
    channels.add(coadminTaskLiveChannel(coadminUid));
  }

  return Array.from(channels);
}

export async function emitCarerTaskOutboxEvent(input: {
  firebaseId: string;
  coadminUid?: unknown;
  assignedCarerUid?: unknown;
  claimedByUid?: unknown;
  playerUid?: unknown;
  type?: unknown;
  status?: unknown;
  automationStatus?: unknown;
  gameName?: unknown;
  amount?: unknown;
  requestId?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
  eventType: 'task.upserted' | 'task.tombstoned';
}) {
  const firebaseId = cleanText(input.firebaseId);
  if (!firebaseId) {
    console.info('[LIVE_OUTBOX] failed', {
      reason: 'missing_carer_task_entity_id',
      eventType: input.eventType,
    });
    return null;
  }

  const channels = resolveCarerTaskOutboxChannels(input);
  if (!channels.length) {
    console.info('[LIVE_OUTBOX] skipped carer task emit', {
      firebaseId,
      eventType: input.eventType,
      reason: 'no_safe_channel',
      status: cleanText(input.status),
    });
    return null;
  }

  const payload = buildCarerTaskOutboxPayload(input);
  const results = await Promise.all(
    channels.map((channel) =>
      insertLiveOutboxEvent({
        channel,
        eventType: input.eventType,
        entityType: 'carer_task',
        entityId: firebaseId,
        payload,
        source: payload.source,
        mirroredAt: payload.mirroredAt,
      })
    )
  );

  return results.find((value) => value !== null) ?? null;
}

export type AutomationJobOutboxPayload = {
  entityId: string;
  jobId: string;
  taskId: string;
  coadminUid: string;
  carerUid: string;
  agentId: string | null;
  type: string;
  status: string;
  gameName: string;
  requestId: string | null;
  updatedAt: string | null;
  mirroredAt: string | null;
  source: string;
};

function extractRequestIdFromTaskId(taskId: unknown) {
  const cleanTaskId = cleanText(taskId);
  if (cleanTaskId.startsWith('request__')) {
    return cleanText(cleanTaskId.slice('request__'.length)) || null;
  }
  return null;
}

export function buildAutomationJobOutboxPayload(input: {
  firebaseId: string;
  taskId?: unknown;
  coadminUid?: unknown;
  carerUid?: unknown;
  createdByUid?: unknown;
  agentId?: unknown;
  type?: unknown;
  status?: unknown;
  gameName?: unknown;
  requestId?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
}): AutomationJobOutboxPayload {
  const entityId = cleanText(input.firebaseId);
  const taskId = cleanText(input.taskId);
  const carerUid = cleanText(input.carerUid) || cleanText(input.createdByUid);
  return {
    entityId,
    jobId: entityId,
    taskId,
    coadminUid: cleanText(input.coadminUid),
    carerUid,
    agentId: cleanText(input.agentId) || null,
    type: cleanText(input.type),
    status: cleanText(input.status),
    gameName: cleanText(input.gameName),
    requestId: cleanText(input.requestId) || extractRequestIdFromTaskId(taskId),
    updatedAt: toIsoString(input.updatedAt),
    mirroredAt: toIsoString(input.mirroredAt) || new Date().toISOString(),
    source: cleanText(input.source) || 'mirror',
  };
}

function resolveAutomationJobOutboxChannels(input: {
  coadminUid?: unknown;
  carerUid?: unknown;
  createdByUid?: unknown;
  status?: unknown;
}) {
  const channels = new Set<string>();
  const carerUid = cleanText(input.carerUid) || cleanText(input.createdByUid);
  const status = cleanText(input.status).toLowerCase();
  const coadminUid = cleanText(input.coadminUid);

  if (carerUid) {
    channels.add(carerJobLiveChannel(carerUid));
  } else if (
    coadminUid &&
    (status === 'queued' ||
      status === 'pending' ||
      status === 'claimed' ||
      status === 'retrying')
  ) {
    channels.add(coadminJobLiveChannel(coadminUid));
  }

  return Array.from(channels);
}

export async function emitAutomationJobOutboxEvent(input: {
  firebaseId: string;
  taskId?: unknown;
  coadminUid?: unknown;
  carerUid?: unknown;
  createdByUid?: unknown;
  agentId?: unknown;
  type?: unknown;
  status?: unknown;
  gameName?: unknown;
  requestId?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
  eventType: 'job.upserted' | 'job.tombstoned';
}) {
  const firebaseId = cleanText(input.firebaseId);
  if (!firebaseId) {
    console.info('[LIVE_OUTBOX] failed', {
      reason: 'missing_automation_job_entity_id',
      eventType: input.eventType,
    });
    return null;
  }

  const channels = resolveAutomationJobOutboxChannels(input);
  if (!channels.length) {
    console.info('[LIVE_OUTBOX] skipped automation job emit', {
      firebaseId,
      eventType: input.eventType,
      reason: 'no_safe_channel',
      status: cleanText(input.status),
    });
    return null;
  }

  const payload = buildAutomationJobOutboxPayload(input);
  const results = await Promise.all(
    channels.map((channel) =>
      insertLiveOutboxEvent({
        channel,
        eventType: input.eventType,
        entityType: 'automation_job',
        entityId: firebaseId,
        payload,
        source: payload.source,
        mirroredAt: payload.mirroredAt,
      })
    )
  );

  return results.find((value) => value !== null) ?? null;
}

export async function emitPlayerRequestOutboxEvent(input: {
  firebaseId: string;
  playerUid: string;
  eventType: 'request.upserted' | 'request.tombstoned';
  type?: unknown;
  status?: unknown;
  gameName?: unknown;
  amount?: unknown;
  baseAmount?: unknown;
  automationStatus?: unknown;
  playerMessage?: unknown;
  retryAttempt?: unknown;
  pokeMessage?: unknown;
  updatedAt?: unknown;
  mirroredAt?: unknown;
  source?: unknown;
}) {
  const playerUid = cleanText(input.playerUid);
  const firebaseId = cleanText(input.firebaseId);
  if (!playerUid || !firebaseId) {
    console.info('[LIVE_OUTBOX] failed', {
      reason: 'missing_player_uid_or_entity_id',
      firebaseId,
      playerUid,
      eventType: input.eventType,
    });
    return null;
  }

  const payload = buildPlayerRequestOutboxPayload(input);
  return insertLiveOutboxEvent({
    channel: playerRequestLiveChannel(playerUid),
    eventType: input.eventType,
    entityType: 'player_game_request',
    entityId: firebaseId,
    payload,
    source: cleanText(input.source) || 'mirror',
    mirroredAt: payload.mirroredAt,
  });
}

export async function getLiveOutboxRowsAfter(
  channels: string[],
  afterOutboxId: number,
  limit = 200
): Promise<LiveOutboxRow[]> {
  const db = getPlayerMirrorPool();
  const cleanChannels = channels.map(cleanText).filter(Boolean);
  if (!db || !cleanChannels.length) {
    return [];
  }

  try {
    const result = await db.query(
      `
        SELECT
          outbox_id,
          channel,
          event_type,
          entity_type,
          entity_id,
          payload,
          payload_hash,
          source,
          mirrored_at,
          created_at
        FROM public.live_outbox
        WHERE channel = ANY($1::text[])
          AND outbox_id > $2
          AND deleted_at IS NULL
        ORDER BY outbox_id ASC
        LIMIT $3
      `,
      [cleanChannels, Math.max(0, afterOutboxId), Math.min(Math.max(limit, 1), 500)]
    );

    return result.rows.map((row) => ({
      outbox_id: Number(row.outbox_id),
      channel: cleanText(row.channel),
      event_type: cleanText(row.event_type),
      entity_type: cleanText(row.entity_type),
      entity_id: cleanText(row.entity_id),
      payload:
        row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {},
      payload_hash: cleanText(row.payload_hash) || null,
      source: cleanText(row.source) || 'mirror',
      mirrored_at: toIsoString(row.mirrored_at),
      created_at: toIsoString(row.created_at) || new Date().toISOString(),
    }));
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'get_rows_after', error });
    return [];
  }
}

export type LatestOutboxLookupResult = {
  latestOutboxId: number;
  timing: PlayerMirrorSqlTiming;
};

function shouldLogLiveOutboxQueryPlan(timing: PlayerMirrorSqlTiming) {
  void timing;
  return (
    process.env.LIVE_OUTBOX_QUERY_PLAN_DEBUG === '1' ||
    process.env.SQL_QUERY_PLAN_DEBUG === '1'
  );
}

async function logLiveOutboxQueryPlan(input: {
  sql: string;
  params: unknown[];
  mirrorClient?: PoolClient;
  acquireContext?: PlayerMirrorAcquireContext;
}) {
  const explainSql = `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${input.sql}`;
  try {
    const result = input.mirrorClient
      ? await runMirrorClientQuery<Record<string, unknown>>(
          input.mirrorClient,
          explainSql,
          input.params
        )
      : await runMirrorPoolQuery<Record<string, unknown>>(
          getPlayerMirrorPool()!,
          explainSql,
          input.params,
          input.acquireContext
        );
    console.info('[LIVE_OUTBOX_QUERY_PLAN]', {
      plan: result.rows[0]?.['QUERY PLAN'] ?? null,
      timing: result.timing,
    });
  } catch (error) {
    console.info('[LIVE_OUTBOX_QUERY_PLAN]', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function getLatestOutboxIdForChannels(
  channels: string[],
  options?: { mirrorClient?: PoolClient; acquireContext?: PlayerMirrorAcquireContext }
): Promise<LatestOutboxLookupResult> {
  const db = getPlayerMirrorPool();
  const cleanChannels = channels.map(cleanText).filter(Boolean);
  const emptyTiming = createPlayerMirrorSqlTiming();
  if (!db || !cleanChannels.length) {
    return { latestOutboxId: 0, timing: emptyTiming };
  }

  const latestSql = `
    SELECT COALESCE(MAX(outbox_id), 0)::bigint AS outbox_id
    FROM public.live_outbox
    WHERE channel = ANY($1::text[])
      AND deleted_at IS NULL
  `;

  try {
    const lookupLatest = async () => {
      if (options?.mirrorClient) {
        return runMirrorClientQuery<{ outbox_id?: unknown }>(
          options.mirrorClient,
          latestSql,
          [cleanChannels]
        );
      }
      return runMirrorPoolQuery<{ outbox_id?: unknown }>(
        db,
        latestSql,
        [cleanChannels],
        options?.acquireContext
      );
    };

    const { rows, timing } = await lookupLatest();
    if (shouldLogLiveOutboxQueryPlan(timing)) {
      await logLiveOutboxQueryPlan({
        sql: latestSql,
        params: [cleanChannels],
        mirrorClient: options?.mirrorClient,
        acquireContext: options?.acquireContext,
      });
    }
    const latestOutboxId = Number(rows[0]?.outbox_id || 0);
    if (isLiveVerboseLogs() || timing.total_ms >= SNAPSHOT_SLOW_MS) {
      console.info('[LIVE_OUTBOX_LATEST_OPTIMIZED]', {
        channels: cleanChannels,
        channelCount: cleanChannels.length,
        latestOutboxId,
        pool_acquire_ms: timing.pool_acquire_ms,
        query_exec_ms: timing.query_exec_ms,
        total_ms: timing.total_ms,
        shared_client: Boolean(options?.mirrorClient),
        query: 'max_outbox_id_by_channels_active',
      });
      console.info(
        '[LIVE_OUTBOX_LATEST_TIMING] channels=%s pool_acquire_ms=%s query_exec_ms=%s total_ms=%s shared_client=%s',
        cleanChannels.join(','),
        timing.pool_acquire_ms,
        timing.query_exec_ms,
        timing.total_ms,
        Boolean(options?.mirrorClient)
      );
    }
    return { latestOutboxId, timing };
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'get_latest_outbox_id', error });
    return { latestOutboxId: 0, timing: emptyTiming };
  }
}

/**
 * Cash-out Telegram consumer transport: coadmin cashout channels only.
 * Authority writes twin rows (player + coadmin); Ledger must read coadmin rows
 * to avoid double fan-out. Soft-deleted rows are excluded. Events are not
 * marked consumed in-place — consumers use durable after-id checkpoints.
 */
export async function getCashoutCoadminOutboxRowsAfter(
  afterOutboxId: number,
  limit = 50
): Promise<LiveOutboxRow[]> {
  const db = getPlayerMirrorPool();
  if (!db) {
    return [];
  }

  try {
    const result = await db.query(
      `
        SELECT
          outbox_id,
          channel,
          event_type,
          entity_type,
          entity_id,
          payload,
          payload_hash,
          source,
          mirrored_at,
          created_at
        FROM public.live_outbox
        WHERE entity_type = 'player_cashout_task'
          AND channel LIKE 'coadmin:%:cashouts'
          AND outbox_id > $1
          AND deleted_at IS NULL
        ORDER BY outbox_id ASC
        LIMIT $2
      `,
      [Math.max(0, afterOutboxId), Math.min(Math.max(limit, 1), 200)]
    );

    return result.rows.map((row) => ({
      outbox_id: Number(row.outbox_id),
      channel: cleanText(row.channel),
      event_type: cleanText(row.event_type),
      entity_type: cleanText(row.entity_type),
      entity_id: cleanText(row.entity_id),
      payload:
        row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {},
      payload_hash: cleanText(row.payload_hash) || null,
      source: cleanText(row.source) || 'mirror',
      mirrored_at: toIsoString(row.mirrored_at),
      created_at: toIsoString(row.created_at) || new Date().toISOString(),
    }));
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'get_cashout_coadmin_rows_after', error });
    return [];
  }
}

export async function getLatestCashoutCoadminOutboxId(): Promise<number> {
  const db = getPlayerMirrorPool();
  if (!db) {
    return 0;
  }

  try {
    const result = await db.query(
      `
        SELECT COALESCE(MAX(outbox_id), 0)::bigint AS outbox_id
        FROM public.live_outbox
        WHERE entity_type = 'player_cashout_task'
          AND channel LIKE 'coadmin:%:cashouts'
          AND deleted_at IS NULL
      `
    );
    return Number(result.rows[0]?.outbox_id || 0);
  } catch (error) {
    console.info('[LIVE_OUTBOX] failed', { reason: 'get_latest_cashout_coadmin_outbox_id', error });
    return 0;
  }
}
