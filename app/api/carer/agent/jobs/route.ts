import { NextResponse } from 'next/server';

import { isAuthoritySqlWriteEnabled } from '@/lib/server/authoritySqlWrite';
import {
  getAutomationAutoStateForAgent,
  getAutomationJobFromSql,
  getCarerTaskFromSql,
  getGameLoginDetailsForAgent,
  listQueuedAutomationJobsForAgent,
  runAgentJobAction,
  verifyAgentLinkedToCarerInSql,
} from '@/lib/sql/authorityAgentJobs';
import { verifyAgentTickSecret } from '@/lib/automation/agentApiAuth';
import { apiError } from '@/lib/firebase/apiAuth';
import { debugLog } from '@/lib/server/verboseLogs';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const carerUid = String(url.searchParams.get('carerUid') || '').trim();
  const agentId = String(url.searchParams.get('agentId') || '').trim();
  const resource = String(url.searchParams.get('resource') || 'queued_jobs').trim().toLowerCase();

  debugLog('[AGENT_JOBS_API_REQUEST]', {
    method: 'GET',
    resource,
    carerUid: carerUid || null,
    agentId: agentId || null,
  });

  if (!isAuthoritySqlWriteEnabled()) {
    return apiError('SQL authority writes are disabled.', 503);
  }
  if (!verifyAgentTickSecret(request)) {
    return apiError('Unauthorized.', 401);
  }

  const limit = Number(url.searchParams.get('limit') || 100);
  const jobId = String(url.searchParams.get('jobId') || '').trim();
  const taskId = String(url.searchParams.get('taskId') || '').trim();
  const coadminUid = String(url.searchParams.get('coadminUid') || '').trim();
  const gameName = String(url.searchParams.get('gameName') || '').trim();

  if (!carerUid || !agentId) {
    return apiError('carerUid and agentId are required.', 400);
  }

  try {
    if (resource === 'queued_jobs') {
      debugLog('[AGENT_JOBS_API_SQL_READ]', {
        resource: 'queued_jobs',
        carerUid,
        agentId,
        limit,
      });
      const jobs = await listQueuedAutomationJobsForAgent({ carerUid, agentId, limit });
      if (!jobs.length) {
        debugLog('[AGENT_JOBS_API_NO_JOBS]', {
          resource: 'queued_jobs',
          carerUid,
          agentId,
        });
      }
      return NextResponse.json({ ok: true, jobs });
    }
    if (resource === 'job' && jobId) {
      const job = await getAutomationJobFromSql(jobId);
      return NextResponse.json({ ok: true, job });
    }
    if (resource === 'task' && taskId) {
      const task = await getCarerTaskFromSql(taskId);
      return NextResponse.json({ ok: true, task });
    }
    if (resource === 'auto_state') {
      const state = await getAutomationAutoStateForAgent(carerUid);
      return NextResponse.json({ ok: true, ...state });
    }
    if (resource === 'game_login' && coadminUid && gameName) {
      const details = await getGameLoginDetailsForAgent(coadminUid, gameName);
      return NextResponse.json({ ok: true, details });
    }
    if (resource === 'verify_link') {
      await verifyAgentLinkedToCarerInSql(carerUid, agentId);
      return NextResponse.json({ ok: true, linked: true });
    }
    return apiError('Unsupported resource.', 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError(message, 500);
  }
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return apiError('Invalid JSON body.', 400);
  }

  const carerUid = String(body.carerUid || '').trim();
  const agentId = String(body.agentId || '').trim();
  const action = String(body.action || '').trim();
  const jobId = String(body.jobId || '').trim();

  debugLog('[AGENT_JOBS_API_REQUEST]', {
    method: 'POST',
    action: action || null,
    carerUid: carerUid || null,
    agentId: agentId || null,
    jobId: jobId || null,
  });

  if (!isAuthoritySqlWriteEnabled()) {
    return apiError('SQL authority writes are disabled.', 503);
  }
  if (!verifyAgentTickSecret(request)) {
    return apiError('Unauthorized.', 401);
  }

  if (!carerUid || !agentId || !action) {
    return apiError('carerUid, agentId, and action are required.', 400);
  }

  try {
    await verifyAgentLinkedToCarerInSql(carerUid, agentId);
    if (action === 'claim') {
      console.info('[AGENT_JOBS_API_CLAIM_ATTEMPT] carerUid=%s agentId=%s jobId=%s', carerUid, agentId, jobId || '-');
    }
    if (action === 'dismiss_midnight_party_blocked_recharge') {
      console.info(
        '[AGENT_JOBS_API_DISMISS_ATTEMPT] jobId=%s carerUid=%s agentId=%s',
        jobId || '-',
        carerUid,
        agentId
      );
    }
    if (action === 'dismiss_player_in_game') {
      console.info(
        '[AGENT_JOBS_API_DISMISS_ATTEMPT] jobId=%s carerUid=%s agentId=%s reasonCode=PLAYER_IN_GAME',
        jobId || '-',
        carerUid,
        agentId
      );
    }
    if (action === 'mark_redeem_waiting_player_exit') {
      console.info(
        '[REDEEM_BLOCKED_PLAYER_IN_GAME] jobId=%s carerUid=%s agentId=%s reasonCode=PLAYER_ACTIVE_IN_GAME',
        jobId || '-',
        carerUid,
        agentId
      );
    }
    if (action === 'complete_recharge_redeem') {
      console.info(
        '[AGENT_JOBS_API_COMPLETE_ATTEMPT] jobId=%s taskId=%s carerUid=%s agentId=%s',
        jobId || '-',
        String(body.taskId || '').trim() || '-',
        carerUid,
        agentId
      );
    }
    const result = await runAgentJobAction({
      action,
      carerUid,
      agentId,
      jobId: jobId || undefined,
      taskId: String(body.taskId || '').trim() || undefined,
      reason: String(body.reason || '').trim() || undefined,
      details: body.details && typeof body.details === 'object' ? (body.details as Record<string, unknown>) : undefined,
      evidence: body.evidence && typeof body.evidence === 'object' ? (body.evidence as Record<string, unknown>) : undefined,
      status: String(body.status || '').trim() || undefined,
      result: body.result && typeof body.result === 'object' ? (body.result as Record<string, unknown>) : undefined,
      errorMessage: String(body.errorMessage || '').trim() || undefined,
      amount: body.amount === undefined ? undefined : Number(body.amount),
      scopeUid: String(body.scopeUid || '').trim() || undefined,
      actorUsername: String(body.actorUsername || '').trim() || undefined,
      carerName: String(body.carerName || '').trim() || undefined,
      limit: body.limit === undefined ? undefined : Number(body.limit),
    });
    if (action === 'claim') {
      if (result && typeof result === 'object' && 'id' in (result as Record<string, unknown>)) {
        const claimed = result as Record<string, unknown>;
        console.info(
          '[AGENT_JOBS_API_CLAIMED] jobId=%s taskId=%s carerUid=%s agentId=%s',
          claimed.id,
          claimed.taskId || '-',
          carerUid,
          agentId
        );
      } else {
        debugLog('[AGENT_JOBS_API_NO_JOBS]', {
          action: 'claim',
          carerUid,
          agentId,
          jobId: jobId || null,
          reason: 'claim_returned_empty',
        });
      }
    }
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[AGENT_JOBS_API] action=%s carerUid=%s error=%s', action, carerUid, message);
    return apiError(message, 500);
  }
}
