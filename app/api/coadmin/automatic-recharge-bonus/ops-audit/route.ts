import { NextResponse } from 'next/server';

import { requireArbReportingApi } from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  listArbOpsAuditInSql,
  resolveArbReportRange,
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
    const result = await listArbOpsAuditInSql({
      coadminUid: gated.coadminUid,
      fromIso: range.fromIso,
      toIso: range.toIso,
      playerUid: cleanText(url.searchParams.get('playerUid')) || null,
      action: cleanText(url.searchParams.get('action')) || null,
      search: cleanText(url.searchParams.get('search')) || null,
      limit: Number(url.searchParams.get('limit') || 80),
      offset: Number(url.searchParams.get('offset') || 0),
    });

    return NextResponse.json({
      success: true,
      range,
      rows: result.rows,
      total: result.total,
      source: 'postgres',
    });
  } catch (error) {
    console.error('[ARB_REPORT_OPS_AUDIT]', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to load ARB ops audit.',
      },
      { status: 500 }
    );
  }
}
