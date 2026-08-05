import { NextResponse } from 'next/server';

import { requireArbReportingApi } from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { loadArbSystemHealthInSql } from '@/lib/sql/authorityAutomaticBonusHealth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Phase 9 — read-only System Health. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const gated = await requireArbReportingApi(request, {
    requestedCoadminUid: cleanText(url.searchParams.get('coadminUid')),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  try {
    const health = await loadArbSystemHealthInSql({
      coadminUid: gated.coadminUid,
      windowHours: Number(url.searchParams.get('windowHours') || 24),
    });
    return NextResponse.json({
      success: true,
      health,
      source: 'postgres',
      readOnly: true,
    });
  } catch (error) {
    console.error('[ARB_SYSTEM_HEALTH]', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to load ARB system health.',
      },
      { status: 500 }
    );
  }
}
