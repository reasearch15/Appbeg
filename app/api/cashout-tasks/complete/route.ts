import { FieldValue } from 'firebase-admin/firestore';
import { NextResponse } from 'next/server';

import { adminDb } from '@/lib/firebase/admin';
import { apiError, requireApiUser, scopedCoadminUid } from '@/lib/firebase/apiAuth';
import {
  authoritySqlWriteEnvLogFields,
  isAuthoritySqlWriteEnabled,
  logAuthoritySqlWrite,
} from '@/lib/server/authoritySqlWrite';
import { completePlayerCashoutTaskInSql } from '@/lib/sql/authorityCashout';
import { getPlayerMirrorPoolStats } from '@/lib/sql/playerMirrorCommon';
import { mirrorFinancialEventById } from '@/lib/sql/financialEventsCache';
import { mirrorPlayerCashoutTaskById } from '@/lib/sql/playerCashoutTasksCache';
import { mirrorUserBalanceSnapshotById } from '@/lib/sql/userBalanceSnapshotsCache';
import { rejectClientSuppliedVendorId } from '@/lib/sql/vendorCashoutAttribution';

export const runtime = 'nodejs';

const ROUTE = '/api/cashout-tasks/complete';

type Body = {
  taskId?: unknown;
  idempotencyKey?: unknown;
};

export async function POST(request: Request) {
  try {
    const auth = await requireApiUser(request, ['admin', 'coadmin', 'staff', 'carer']);
    if ('response' in auth) return auth.response;

    const body = (await request.json()) as Body & Record<string, unknown>;
    rejectClientSuppliedVendorId(body);
    const taskId = String(body.taskId || '').trim();
    if (!taskId) {
      return apiError('taskId is required.', 400);
    }
    const idempotencyKey =
      String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '').trim() || null;

    if (isAuthoritySqlWriteEnabled()) {
      console.info('[CASHOUT_TASK_DONE] attempting', {
        taskId,
        actorUid: auth.user.uid,
        actorRole: auth.user.role,
        coadminUid: scopedCoadminUid(auth.user),
      });
      const result = await completePlayerCashoutTaskInSql({
        taskId,
        actorUid: auth.user.uid,
        actorUsername: auth.user.username,
        actorRole: auth.user.role,
        isAdmin: auth.user.role === 'admin',
        scopeUid: scopedCoadminUid(auth.user),
        idempotencyKey,
      });
      const poolStats = getPlayerMirrorPoolStats();

      logAuthoritySqlWrite(ROUTE, {
        ...authoritySqlWriteEnvLogFields(),
        taskId,
        duplicate: result.duplicate,
        alreadyCompleted: result.alreadyCompleted,
        route: ROUTE,
        pool_totalCount: poolStats?.totalCount ?? null,
        pool_idleCount: poolStats?.idleCount ?? null,
        pool_waitingCount: poolStats?.waitingCount ?? null,
        pool_max: poolStats?.max ?? null,
      });

      return NextResponse.json({
        success: true,
        status: 'completed',
        alreadyCompleted: result.alreadyCompleted,
        duplicate: result.duplicate,
        authority: 'sql',
      });
    }

    const caller = auth.user;
    const callerIsAdmin = caller.role === 'admin';
    const callerScope = scopedCoadminUid(caller);
    const taskRef = adminDb.collection('playerCashoutTasks').doc(taskId);
    const handlerRef = adminDb.collection('users').doc(caller.uid);
    const eventRef = adminDb.collection('financialEvents').doc();
    const mirroredUserIds = new Set<string>();

    const result = await adminDb.runTransaction(async (transaction) => {
      const [taskSnap, handlerSnap] = await Promise.all([
        transaction.get(taskRef),
        transaction.get(handlerRef),
      ]);
      if (!taskSnap.exists) {
        throw new Error('Cashout task not found.');
      }

      const task = taskSnap.data() as {
        status?: string;
        coadminUid?: string;
        playerUid?: string;
        amountNpr?: number;
        cashDeductedOnRequest?: boolean;
        assignedHandlerUid?: string | null;
        startedAt?: unknown;
      };
      const status = String(task.status || '').toLowerCase();
      if (status === 'completed') {
        return { alreadyCompleted: true };
      }
      if (status !== 'pending' && status !== 'in_progress') {
        throw new Error('Cashout task is not available to complete.');
      }

      const taskScope = String(task.coadminUid || '').trim();
      if (!callerIsAdmin && (!callerScope || callerScope !== taskScope)) {
        throw new Error('Forbidden: cashout task is outside your scope.');
      }
      if (
        status === 'in_progress' &&
        task.assignedHandlerUid &&
        task.assignedHandlerUid !== caller.uid &&
        !callerIsAdmin &&
        caller.role !== 'coadmin'
      ) {
        throw new Error('This task is already assigned to another handler.');
      }

      const requestedAmount = Number(task.amountNpr || 0);
      if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
        throw new Error('Cashout task amount is invalid.');
      }

      const shouldDeductOnComplete = task.cashDeductedOnRequest === false;
      let playerRef: FirebaseFirestore.DocumentReference | null = null;
      let playerCash = 0;
      if (shouldDeductOnComplete) {
        playerRef = adminDb.collection('users').doc(String(task.playerUid || '').trim());
        const playerSnap = await transaction.get(playerRef);
        if (!playerSnap.exists) {
          throw new Error('Cashout task player not found.');
        }
        playerCash = Number((playerSnap.data() as { cash?: number }).cash || 0);
        if (!Number.isFinite(playerCash) || playerCash < requestedAmount) {
          throw new Error('Cashout task player cash is lower than the requested amount.');
        }
      }

      const handlerData = handlerSnap.exists
        ? (handlerSnap.data() as { cashBoxNpr?: number; rewardBlocked?: boolean })
        : { cashBoxNpr: 0, rewardBlocked: false };
      const rewardNpr = Math.max(1, Math.round(requestedAmount * 0.05));
      const rewardAppliedNpr = Boolean(handlerData.rewardBlocked) ? 0 : rewardNpr;
      const handlerCreditAmount = requestedAmount + rewardAppliedNpr;
      const cashBoxBefore = Number(handlerData.cashBoxNpr || 0);
      const cashBoxAfter = cashBoxBefore + handlerCreditAmount;

      transaction.update(taskRef, {
        status: 'completed',
        assignedHandlerUid: caller.uid,
        assignedHandlerUsername: caller.username || 'Handler',
        cashoutRequestedByStaffId: caller.role === 'staff' ? caller.uid : null,
        rewardNprApplied: rewardAppliedNpr,
        rewardBlockedApplied: Boolean(handlerData.rewardBlocked),
        payoutAmountNpr: requestedAmount,
        rewardAmountNpr: rewardAppliedNpr,
        cashBoxBefore,
        cashBoxAfter,
        cashBoxDelta: cashBoxAfter - cashBoxBefore,
        actorUid: caller.uid,
        actorRole: caller.role,
        sourceCashoutId: taskId,
        startedAt: task.startedAt || FieldValue.serverTimestamp(),
        expiresAt: null,
        completedAt: FieldValue.serverTimestamp(),
      });
      if (shouldDeductOnComplete && playerRef) {
        transaction.update(playerRef, { cash: playerCash - requestedAmount });
        mirroredUserIds.add(String(task.playerUid || '').trim());
      }
      transaction.set(
        handlerRef,
        {
          cashBoxNpr: cashBoxAfter,
        },
        { merge: true }
      );
      mirroredUserIds.add(caller.uid);
      transaction.set(eventRef, {
        playerUid: String(task.playerUid || '').trim(),
        coadminUid: taskScope,
        amountNpr: requestedAmount,
        type: 'cashout',
        cashoutTaskId: taskId,
        createdAt: FieldValue.serverTimestamp(),
      });

      return { alreadyCompleted: false };
    });

    if (!result.alreadyCompleted) {
      void mirrorFinancialEventById(eventRef.id, 'appbeg_cashout_complete');
      void mirrorPlayerCashoutTaskById(taskId, 'appbeg_cashout_complete');
      mirroredUserIds.forEach((uid) => {
        void mirrorUserBalanceSnapshotById(uid, 'appbeg_cashout_complete');
      });
    }
    return NextResponse.json({ success: true, ...result, authority: 'firestore' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to complete cashout task.';
    const status =
      /not authenticated|authorization|token/i.test(message)
        ? 401
        : /forbidden|outside your scope|already assigned/i.test(message)
          ? 403
          : /already|not available|conflict/i.test(message)
            ? 409
            : /required|not found|invalid|only/i.test(message)
              ? 400
              : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
