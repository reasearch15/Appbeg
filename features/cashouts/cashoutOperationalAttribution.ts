import type {
  CashoutOperationalClaim,
  CashoutOperationalCompletion,
  PlayerCashoutTask,
} from '@/features/cashouts/playerCashoutTasks';

function clean(value: unknown): string | null {
  const text = String(value ?? '').trim();
  return text || null;
}

export function isTelegramOperationalClaim(
  claim: CashoutOperationalClaim | null | undefined
): boolean {
  return String(claim?.actionSource || '').toLowerCase() === 'telegram'
    && Boolean(clean(claim?.telegramUserId) || clean(claim?.telegramDisplayName));
}

export function isTelegramOperationalCompletion(
  completion: CashoutOperationalCompletion | null | undefined
): boolean {
  return String(completion?.actionSource || '').toLowerCase() === 'telegram'
    && Boolean(
      clean(completion?.telegramUserId)
      || clean(completion?.telegramDisplayName)
      || clean(completion?.telegramCompletedAt)
    );
}

export function telegramOperationalPersonLabel(
  ops: {
    telegramDisplayName?: string | null;
    telegramUsername?: string | null;
    telegramUserId?: string | null;
  } | null | undefined
): string | null {
  if (!ops) return null;
  const display = clean(ops.telegramDisplayName);
  if (display) return display;
  const username = clean(ops.telegramUsername);
  if (username) return username.startsWith('@') ? username : `@${username}`;
  // Prefer not showing raw Telegram IDs in Coadmin/Staff UI.
  return null;
}

export function telegramOperationalUsernameLine(
  ops: { telegramUsername?: string | null } | null | undefined
): string | null {
  const username = clean(ops?.telegramUsername);
  if (!username) return null;
  return username.startsWith('@') ? username : `@${username}`;
}

/**
 * Map raw cache JSON operational claim/completion onto UI task fields.
 */
export function mapOperationalFieldsFromCacheRow(row: Record<string, unknown>): {
  operationalClaim: CashoutOperationalClaim | null;
  operationalCompletion: CashoutOperationalCompletion | null;
} {
  const claimRaw = row.operationalClaim;
  const completionRaw = row.operationalCompletion;
  const attrs = row.operationalAttribution;

  let operationalClaim: CashoutOperationalClaim | null = null;
  if (claimRaw && typeof claimRaw === 'object' && !Array.isArray(claimRaw)) {
    const c = claimRaw as Record<string, unknown>;
    operationalClaim = {
      actionSource: clean(c.actionSource) || 'telegram',
      telegramUserId: clean(c.telegramUserId),
      telegramUsername: clean(c.telegramUsername),
      telegramDisplayName: clean(c.telegramDisplayName),
      telegramClaimedAt: clean(c.telegramClaimedAt),
    };
  } else if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    const a = attrs as Record<string, unknown>;
    if (clean(a.actionSource) || clean(a.telegramUserId)) {
      operationalClaim = {
        actionSource: clean(a.actionSource) || 'telegram',
        telegramUserId: clean(a.telegramUserId),
        telegramUsername: clean(a.telegramUsername),
        telegramDisplayName: clean(a.telegramDisplayName),
        telegramClaimedAt: clean(a.telegramClaimedAt),
      };
    }
  }

  let operationalCompletion: CashoutOperationalCompletion | null = null;
  if (completionRaw && typeof completionRaw === 'object' && !Array.isArray(completionRaw)) {
    const c = completionRaw as Record<string, unknown>;
    if (clean(c.actionSource) || clean(c.telegramUserId) || clean(c.telegramCompletedAt)) {
      operationalCompletion = {
        actionSource: clean(c.actionSource) || 'telegram',
        telegramUserId: clean(c.telegramUserId),
        telegramUsername: clean(c.telegramUsername),
        telegramDisplayName: clean(c.telegramDisplayName),
        telegramCompletedAt: clean(c.telegramCompletedAt),
      };
    }
  } else if (attrs && typeof attrs === 'object' && !Array.isArray(attrs)) {
    const a = attrs as Record<string, unknown>;
    if (clean(a.telegramCompletedAt) || clean(a.completionSource) === 'telegram') {
      operationalCompletion = {
        actionSource: clean(a.completionSource) || 'telegram',
        telegramUserId: clean(a.telegramUserId),
        telegramUsername: clean(a.telegramUsername),
        telegramDisplayName: clean(a.telegramDisplayName),
        telegramCompletedAt: clean(a.telegramCompletedAt),
      };
    }
  }

  return { operationalClaim, operationalCompletion };
}

export function taskHasTelegramClaim(task: PlayerCashoutTask | null | undefined): boolean {
  return isTelegramOperationalClaim(task?.operationalClaim);
}

export function taskHasTelegramCompletion(task: PlayerCashoutTask | null | undefined): boolean {
  return isTelegramOperationalCompletion(task?.operationalCompletion);
}
