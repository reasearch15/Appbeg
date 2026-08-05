import 'server-only';

import type { Pool, PoolClient } from 'pg';

import { getPlayerMirrorPool, cleanText } from '@/lib/sql/playerMirrorCommon';

/**
 * Automatic Recharge Bonus — request-scoped financial reconciliation (Phase 6 ops).
 *
 * Verifies consistency across:
 *   Recharge Request → Evaluation → Financial Event → Ledger → Balance Delta
 * using a single request identifier.
 *
 * Read-only. Never mutates balances or writes financial events.
 */

export type ArbReconcileIssue = {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
};

export type ArbReconcileReport = {
  requestId: string;
  ok: boolean;
  issues: ArbReconcileIssue[];
  request: {
    found: boolean;
    type: string | null;
    status: string | null;
    playerUid: string | null;
    amount: number | null;
    baseAmount: number | null;
    appliedStamp: boolean;
    appliedAmount: number | null;
    evaluationIdStamp: string | null;
    financialEventIdHint: string | null;
  };
  evaluations: Array<{
    evaluationId: string;
    mode: string;
    evaluationResult: string;
    eligible: boolean;
    bonusCalculated: number;
    tierId: string | null;
    configVersionId: string | null;
    skipReason: string | null;
    evaluatedAt: string | null;
  }>;
  financialEvents: Array<{
    eventId: string;
    amountNpr: number;
    beforeCoin: number | null;
    afterCoin: number | null;
    coinDelta: number | null;
    playerUid: string | null;
    createdAt: string | null;
  }>;
  ledger: Array<{
    eventKey: string;
    balanceType: string;
    direction: string;
    delta: number;
    absoluteAfter: number | null;
    eventType: string;
    sourceId: string;
  }>;
  balanceDelta: {
    evaluationBonus: number | null;
    financialEventTotal: number;
    ledgerCoinCredit: number;
    ledgerPromoLockedCredit: number;
    feCoinDeltaTotal: number;
  };
};

type Queryable = Pool | PoolClient;

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function issue(
  code: string,
  severity: ArbReconcileIssue['severity'],
  message: string
): ArbReconcileIssue {
  return { code, severity, message };
}

function readRawField(raw: unknown, field: string) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return (raw as Record<string, unknown>)[field];
}

/**
 * Reconcile Automatic Recharge Bonus financial artifacts for one recharge request.
 */
export async function reconcileArbGrantByRequestId(
  requestIdInput: string,
  options?: { client?: Queryable }
): Promise<ArbReconcileReport> {
  const requestId = cleanText(requestIdInput);
  if (!requestId) {
    throw new Error('requestId is required.');
  }

  const db = options?.client || getPlayerMirrorPool();
  if (!db) throw new Error('SQL authority unavailable.');

  const issues: ArbReconcileIssue[] = [];

  const requestResult = await db.query(
    `
      SELECT
        firebase_id,
        type,
        status,
        player_uid,
        amount,
        base_amount,
        raw_firestore_data
      FROM public.player_game_requests_cache
      WHERE firebase_id = $1
      LIMIT 1
    `,
    [requestId]
  );

  const requestRow = requestResult.rows[0] as Record<string, unknown> | undefined;
  const requestRaw = requestRow?.raw_firestore_data;
  const appliedStamp = readRawField(requestRaw, 'automaticRechargeBonusApplied') === true;
  const appliedAmount = num(readRawField(requestRaw, 'automaticRechargeBonusAmount'));
  const evaluationIdStamp = cleanText(
    readRawField(requestRaw, 'automaticRechargeBonusEvaluationId')
  );
  const financialEventIdHint = cleanText(
    readRawField(requestRaw, 'automaticRechargeBonusFinancialEventId')
  );

  const request = {
    found: Boolean(requestRow),
    type: cleanText(requestRow?.type) || null,
    status: cleanText(requestRow?.status) || null,
    playerUid: cleanText(requestRow?.player_uid) || null,
    amount: num(requestRow?.amount),
    baseAmount: num(requestRow?.base_amount),
    appliedStamp,
    appliedAmount,
    evaluationIdStamp: evaluationIdStamp || null,
    financialEventIdHint: financialEventIdHint || null,
  };

  if (!request.found) {
    issues.push(
      issue('request_missing', 'warning', 'Recharge request not found in player_game_requests_cache.')
    );
  } else if (request.type && request.type.toLowerCase() !== 'recharge') {
    issues.push(
      issue(
        'request_not_recharge',
        'warning',
        `Request type is "${request.type}" (expected recharge).`
      )
    );
  }

  const evalResult = await db.query(
    `
      SELECT
        evaluation_id,
        mode,
        evaluation_result,
        eligible,
        bonus_calculated,
        tier_id,
        config_version_id,
        skip_reason,
        evaluated_at,
        raw_json
      FROM public.automatic_recharge_bonus_evaluations
      WHERE request_id = $1
      ORDER BY evaluated_at ASC, id ASC
    `,
    [requestId]
  );

  const evaluations = evalResult.rows.map((row: Record<string, unknown>) => ({
    evaluationId: cleanText(row.evaluation_id),
    mode: cleanText(row.mode),
    evaluationResult: cleanText(row.evaluation_result),
    eligible: row.eligible === true,
    bonusCalculated: num(row.bonus_calculated) ?? 0,
    tierId: cleanText(row.tier_id) || null,
    configVersionId: cleanText(row.config_version_id) || null,
    skipReason: cleanText(row.skip_reason) || null,
    evaluatedAt: row.evaluated_at
      ? new Date(String(row.evaluated_at)).toISOString()
      : null,
  }));

  const feResult = await db.query(
    `
      SELECT
        firebase_id,
        amount_npr,
        before_coin,
        after_coin,
        player_uid,
        created_at,
        type
      FROM public.financial_events_cache
      WHERE request_id = $1
        AND type = 'automatic_recharge_bonus'
        AND deleted_at IS NULL
      ORDER BY created_at ASC
    `,
    [requestId]
  );

  const financialEvents = feResult.rows.map((row: Record<string, unknown>) => {
    const beforeCoin = num(row.before_coin);
    const afterCoin = num(row.after_coin);
    return {
      eventId: cleanText(row.firebase_id),
      amountNpr: num(row.amount_npr) ?? 0,
      beforeCoin,
      afterCoin,
      coinDelta:
        beforeCoin != null && afterCoin != null ? afterCoin - beforeCoin : null,
      playerUid: cleanText(row.player_uid) || null,
      createdAt: row.created_at
        ? new Date(String(row.created_at)).toISOString()
        : null,
    };
  });

  const feIds = financialEvents.map((fe) => fe.eventId).filter(Boolean);
  let ledgerRows: Record<string, unknown>[] = [];
  if (feIds.length) {
    const ledgerResult = await db.query(
      `
        SELECT
          event_key,
          balance_type,
          direction,
          delta,
          absolute_after,
          event_type,
          source_id
        FROM public.user_balance_events
        WHERE source_id = ANY($1::text[])
          AND event_type IN (
            'automatic_recharge_bonus_coin_credit',
            'automatic_recharge_bonus_promo_locked_credit'
          )
        ORDER BY source_created_at ASC NULLS LAST, event_key ASC
      `,
      [feIds]
    );
    ledgerRows = ledgerResult.rows as Record<string, unknown>[];
  }

  const ledger = ledgerRows.map((row) => ({
    eventKey: cleanText(row.event_key),
    balanceType: cleanText(row.balance_type),
    direction: cleanText(row.direction),
    delta: num(row.delta) ?? 0,
    absoluteAfter: num(row.absolute_after),
    eventType: cleanText(row.event_type),
    sourceId: cleanText(row.source_id),
  }));

  const grantEvals = evaluations.filter((e) => e.mode === 'grant');
  const grantedEvals = grantEvals.filter((e) => e.evaluationResult === 'granted');
  const shadowWouldGrant = evaluations.filter(
    (e) => e.mode === 'shadow' && e.evaluationResult === 'would_grant'
  );

  if (grantEvals.length > 1) {
    issues.push(
      issue(
        'multiple_grant_evaluations',
        'error',
        `Expected at most one grant evaluation; found ${grantEvals.length}.`
      )
    );
  }

  if (financialEvents.length > 1) {
    issues.push(
      issue(
        'multiple_financial_events',
        'error',
        `Expected at most one automatic_recharge_bonus FE; found ${financialEvents.length}.`
      )
    );
  }

  const evaluationBonus =
    grantedEvals[0]?.bonusCalculated ??
    (appliedStamp ? appliedAmount : null);

  const financialEventTotal = financialEvents.reduce((sum, fe) => sum + fe.amountNpr, 0);
  const ledgerCoinCredit = ledger
    .filter((l) => l.eventType === 'automatic_recharge_bonus_coin_credit')
    .reduce((sum, l) => sum + l.delta, 0);
  const ledgerPromoLockedCredit = ledger
    .filter((l) => l.eventType === 'automatic_recharge_bonus_promo_locked_credit')
    .reduce((sum, l) => sum + l.delta, 0);
  const feCoinDeltaTotal = financialEvents.reduce(
    (sum, fe) => sum + (fe.coinDelta ?? 0),
    0
  );

  // --- Consistency rules ---

  if (grantedEvals.length > 0) {
    const granted = grantedEvals[0];
    if (financialEvents.length === 0) {
      issues.push(
        issue(
          'granted_without_financial_event',
          'error',
          'Grant evaluation result=granted but no automatic_recharge_bonus financial event.'
        )
      );
    }
    if (!appliedStamp && request.found) {
      issues.push(
        issue(
          'granted_without_request_stamp',
          'warning',
          'Grant evaluation exists but request raw lacks automaticRechargeBonusApplied=true.'
        )
      );
    }
    if (financialEvents.length === 1 && granted.bonusCalculated !== financialEvents[0].amountNpr) {
      issues.push(
        issue(
          'evaluation_fe_amount_mismatch',
          'error',
          `Evaluation bonus ${granted.bonusCalculated} != FE amount ${financialEvents[0].amountNpr}.`
        )
      );
    }
    if (
      evaluationIdStamp &&
      granted.evaluationId &&
      evaluationIdStamp !== granted.evaluationId
    ) {
      issues.push(
        issue(
          'evaluation_id_stamp_mismatch',
          'warning',
          `Request stamp evaluation id ${evaluationIdStamp} != ${granted.evaluationId}.`
        )
      );
    }
  }

  if (financialEvents.length > 0 && grantedEvals.length === 0) {
    issues.push(
      issue(
        'financial_event_without_granted_evaluation',
        'error',
        'automatic_recharge_bonus FE exists without a grant evaluation result=granted.'
      )
    );
  }

  if (appliedStamp && financialEvents.length === 0) {
    issues.push(
      issue(
        'applied_stamp_without_financial_event',
        'error',
        'Request stamped automaticRechargeBonusApplied but no financial event found.'
      )
    );
  }

  for (const fe of financialEvents) {
    if (fe.coinDelta != null && fe.coinDelta !== fe.amountNpr) {
      issues.push(
        issue(
          'fe_balance_delta_mismatch',
          'error',
          `FE ${fe.eventId}: after_coin-before_coin (${fe.coinDelta}) != amount_npr (${fe.amountNpr}).`
        )
      );
    }
    if (request.playerUid && fe.playerUid && fe.playerUid !== request.playerUid) {
      issues.push(
        issue(
          'fe_player_mismatch',
          'error',
          `FE player ${fe.playerUid} != request player ${request.playerUid}.`
        )
      );
    }
  }

  if (financialEvents.length > 0) {
    if (ledgerCoinCredit !== financialEventTotal) {
      issues.push(
        issue(
          'ledger_coin_mismatch',
          'error',
          `Ledger coin credit ${ledgerCoinCredit} != FE total ${financialEventTotal}.`
        )
      );
    }
    if (ledgerPromoLockedCredit !== financialEventTotal) {
      issues.push(
        issue(
          'ledger_promo_locked_mismatch',
          'error',
          `Ledger promoLocked credit ${ledgerPromoLockedCredit} != FE total ${financialEventTotal}.`
        )
      );
    }
    for (const fe of financialEvents) {
      const coinLedgers = ledger.filter(
        (l) =>
          l.sourceId === fe.eventId &&
          l.eventType === 'automatic_recharge_bonus_coin_credit'
      );
      const promoLedgers = ledger.filter(
        (l) =>
          l.sourceId === fe.eventId &&
          l.eventType === 'automatic_recharge_bonus_promo_locked_credit'
      );
      if (coinLedgers.length !== 1) {
        issues.push(
          issue(
            'ledger_coin_row_count',
            'error',
            `FE ${fe.eventId}: expected 1 coin ledger row, found ${coinLedgers.length}.`
          )
        );
      }
      if (promoLedgers.length !== 1) {
        issues.push(
          issue(
            'ledger_promo_row_count',
            'error',
            `FE ${fe.eventId}: expected 1 promoLocked ledger row, found ${promoLedgers.length}.`
          )
        );
      }
      if (
        coinLedgers[0] &&
        fe.afterCoin != null &&
        coinLedgers[0].absoluteAfter != null &&
        coinLedgers[0].absoluteAfter !== fe.afterCoin
      ) {
        issues.push(
          issue(
            'ledger_absolute_after_mismatch',
            'error',
            `FE ${fe.eventId}: ledger absolute_after ${coinLedgers[0].absoluteAfter} != FE after_coin ${fe.afterCoin}.`
          )
        );
      }
    }
  }

  // Shadow-only path must never leave financial artifacts.
  if (
    shadowWouldGrant.length > 0 &&
    grantedEvals.length === 0 &&
    financialEvents.length > 0
  ) {
    issues.push(
      issue(
        'shadow_with_financial_writes',
        'error',
        'Shadow would_grant evaluation coexists with financial events (without granted eval).'
      )
    );
  }

  if (
    grantEvals.length === 1 &&
    grantEvals[0].evaluationResult !== 'granted' &&
    financialEvents.length > 0
  ) {
    issues.push(
      issue(
        'non_granted_eval_with_finances',
        'error',
        `Grant evaluation result=${grantEvals[0].evaluationResult} but financial events exist.`
      )
    );
  }

  if (
    evaluations.length === 0 &&
    financialEvents.length === 0 &&
    !appliedStamp
  ) {
    issues.push(
      issue(
        'no_arb_artifacts',
        'info',
        'No Automatic Recharge Bonus evaluation, financial event, or applied stamp for this request.'
      )
    );
  }

  const hasError = issues.some((i) => i.severity === 'error');

  return {
    requestId,
    ok: !hasError,
    issues,
    request,
    evaluations,
    financialEvents,
    ledger,
    balanceDelta: {
      evaluationBonus,
      financialEventTotal,
      ledgerCoinCredit,
      ledgerPromoLockedCredit,
      feCoinDeltaTotal,
    },
  };
}
