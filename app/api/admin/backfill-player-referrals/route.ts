import { NextResponse } from 'next/server';

import {
  isAppbegSqlOnlyMode,
  isFirebaseFallbackAllowed,
} from '@/lib/server/appbegSqlOnlyMode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE = '/api/admin/backfill-player-referrals';

function disabledResponse(reason = 'sql_only_mode') {
  return NextResponse.json(
    {
      success: false,
      error: 'Player referral Firebase backfill is disabled. PostgreSQL is the authoritative runtime.',
      route: ROUTE,
      reason,
    },
    { status: 410 }
  );
}

export async function POST(request: Request) {
  void request;
  if (isAppbegSqlOnlyMode() || !isFirebaseFallbackAllowed()) {
    return disabledResponse(isAppbegSqlOnlyMode() ? 'sql_only_mode' : 'firebase_fallback_disabled');
  }

  return disabledResponse('legacy_firebase_backfill_removed');
}
