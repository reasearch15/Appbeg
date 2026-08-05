import { NextResponse } from 'next/server';

import { apiError } from '@/lib/firebase/apiAuth';
import { requireArbReportingApi } from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { reconcileArbRequestForReportInSql } from '@/lib/sql/authorityAutomaticBonusReport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const gated = await requireArbReportingApi(request, {
    requestedCoadminUid: cleanText(url.searchParams.get('coadminUid')),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  const requestId = cleanText(url.searchParams.get('requestId'));
  if (!requestId) {
    return apiError('requestId is required.', 400);
  }

  try {
    const report = await reconcileArbRequestForReportInSql({
      coadminUid: gated.coadminUid,
      requestId,
    });
    return NextResponse.json({
      success: true,
      report,
      source: 'postgres',
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to reconcile ARB request.';
    console.error('[ARB_REPORT_RECONCILE]', error);
    const status = /outside coadmin scope/i.test(message) ? 403 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
