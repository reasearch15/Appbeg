import { NextResponse } from 'next/server';

import { apiError } from '@/lib/firebase/apiAuth';
import { requireArbReportingApi } from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { inspectArbPlayerInSql } from '@/lib/sql/authorityAutomaticBonusReport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Administrator / coadmin read-only player inspection panel (Phase 8).
 * Never mutates preference, balances, or grants.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const gated = await requireArbReportingApi(request, {
    requestedCoadminUid: cleanText(url.searchParams.get('coadminUid')),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  // Admin-only deep inspect (coadmins use player history; this panel is admin debug).
  if (gated.actorRole !== 'admin') {
    return apiError('Administrator role required for ARB player inspect.', 403);
  }

  const playerUid = cleanText(url.searchParams.get('playerUid'));
  if (!playerUid) {
    return apiError('playerUid is required.', 400);
  }

  try {
    const sampleRaw = url.searchParams.get('sampleRechargeAmount');
    const inspection = await inspectArbPlayerInSql({
      coadminUid: gated.coadminUid,
      playerUid,
      sampleRechargeAmount: sampleRaw != null ? Number(sampleRaw) : 50,
    });
    return NextResponse.json({
      success: true,
      inspection,
      source: 'postgres',
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to inspect ARB player.';
    console.error('[ARB_REPORT_PLAYER_INSPECT]', error);
    const status = /not found|outside coadmin scope/i.test(message) ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
