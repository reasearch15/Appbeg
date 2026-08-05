import { NextResponse } from 'next/server';

import { requireArbReportingApi } from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  resolveArbReportRange,
  summarizeArbDashboardInSql,
} from '@/lib/sql/authorityAutomaticBonusReport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const gated = await requireArbReportingApi(request, {
    requestedCoadminUid: cleanText(url.searchParams.get('coadminUid')),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  try {
    const range = resolveArbReportRange({
      preset: url.searchParams.get('preset'),
      from: url.searchParams.get('from'),
      to: url.searchParams.get('to'),
    });
    const stats = await summarizeArbDashboardInSql({
      coadminUid: gated.coadminUid,
      fromIso: range.fromIso,
      toIso: range.toIso,
    });
    return NextResponse.json({
      success: true,
      stats,
      source: 'postgres',
    });
  } catch (error) {
    console.error('[ARB_REPORT_STATS]', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to load ARB stats.',
      },
      { status: 500 }
    );
  }
}
