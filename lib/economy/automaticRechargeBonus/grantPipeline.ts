/**
 * Automatic Recharge Bonus — FROZEN GRANT PIPELINE (Phase 6+).
 *
 * THIS IS THE ONLY SUPPORTED PATH FOR ARB FINANCIAL WRITES.
 *
 * Allowed sequence (must not be bypassed):
 *   1. planArbRechargeCompletionGrant()  — pure eligibility + resolve + shadow/grant plan
 *   2. applyArbOnRechargeCompleteInTxn() — SQL evaluation claim + optional FE/ledger/balance
 *
 * Call site today:
 *   completeRechargeRedeemTaskInSql → applyArbOnRechargeCompleteInTxn
 *
 * Future features MUST NOT:
 *   - Insert financial_events_cache rows with type 'automatic_recharge_bonus'
 *   - Credit coin / promoLockedCoins for ARB outside applyArbOnRechargeCompleteInTxn
 *   - Re-implement eligibility, cooldown, tier selection, or bonus calculation
 *   - Call resolveAutomaticRechargeBonus for financial side effects without the planner
 *
 * Enforcement:
 *   - npm run test:arb-grant-freeze
 *   - reconcileArbGrantByRequestId for post-hoc consistency checks
 *
 * Shadow vs grant differs only in writeFinances — same planner pipeline.
 */

export const ARB_GRANT_PIPELINE = {
  plannerModule: 'lib/economy/automaticRechargeBonus/grantPlan.ts',
  plannerExport: 'planArbRechargeCompletionGrant',
  sqlApplyModule: 'lib/sql/authorityAutomaticBonusGrant.ts',
  sqlApplyExport: 'applyArbOnRechargeCompleteInTxn',
  financialEventType: 'automatic_recharge_bonus',
  reconcileModule: 'lib/sql/authorityAutomaticBonusReconcile.ts',
  reconcileExport: 'reconcileArbGrantByRequestId',
} as const;

export type ArbGrantPipeline = typeof ARB_GRANT_PIPELINE;
