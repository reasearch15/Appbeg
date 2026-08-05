import { NextResponse } from 'next/server';

import { apiError, requireApiUser } from '@/lib/firebase/apiAuth';
import { isArbPlayerModeEnabled } from '@/lib/server/automaticRechargeBonusFlags';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  ArbPlayerToggleError,
  loadArbPlayerPreferenceInSql,
  setArbPlayerPreferenceInSql,
} from '@/lib/sql/authorityAutomaticBonusToggle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function readIdempotencyKey(request: Request, body: Record<string, unknown>) {
  const header = cleanText(request.headers.get('Idempotency-Key'));
  if (header) return header;
  return cleanText(body.idempotencyKey);
}

function errorResponse(error: unknown) {
  if (error instanceof ArbPlayerToggleError) {
    const status =
      error.code === 'player_not_found'
        ? 404
        : error.code === 'player_mode_disabled'
          ? 503
          : 403;
    return NextResponse.json(
      {
        error: error.message,
        code: error.code,
        blockers: error.blockers,
      },
      { status }
    );
  }
  const message =
    error instanceof Error
      ? error.message
      : 'Automatic Recharge Bonus preference request failed.';
  if (/SQL authority unavailable|Postgres/i.test(message)) {
    return apiError(message, 503);
  }
  console.error('[ARB_PLAYER_PREFERENCE]', error);
  return apiError(message, 500);
}

export async function GET(request: Request) {
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) return auth.response;
  if (!isDatabaseUrlConfigured()) {
    return apiError('SQL authority unavailable.', 503);
  }

  try {
    const snapshot = await loadArbPlayerPreferenceInSql({
      playerUid: auth.user.uid,
    });
    return NextResponse.json({
      success: true,
      playerModeEnabled: isArbPlayerModeEnabled(),
      ...snapshot,
      source: 'postgres',
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['player']);
  if ('response' in auth) return auth.response;
  if (!isDatabaseUrlConfigured()) {
    return apiError('SQL authority unavailable.', 503);
  }

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json(
      {
        error: 'enabled must be a boolean.',
        code: 'invalid_request',
        blockers: ['invalid_request'],
      },
      { status: 400 }
    );
  }

  try {
    const result = await setArbPlayerPreferenceInSql({
      playerUid: auth.user.uid,
      enabled: body.enabled,
      actorUid: auth.user.uid,
      actorRole: auth.user.role,
      idempotencyKey: readIdempotencyKey(request, body),
    });

    return NextResponse.json({
      success: true,
      duplicate: result.duplicate,
      changed: result.changed,
      transition: result.transition,
      startedCooldown: result.startedCooldown,
      cancelledCooldown: result.cancelledCooldown,
      ...result.snapshot,
      source: 'postgres',
    });
  } catch (error) {
    return errorResponse(error);
  }
}
