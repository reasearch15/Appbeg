import { NextResponse } from 'next/server';

import { requireArbReportingApi } from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  listArbEvaluationsForReportInSql,
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
    const modeRaw = cleanText(url.searchParams.get('mode'));
    const mode =
      modeRaw === 'shadow' || modeRaw === 'grant' ? modeRaw : null;
    const eligibleRaw = cleanText(url.searchParams.get('eligible'));
    const eligible =
      eligibleRaw === 'true' ? true : eligibleRaw === 'false' ? false : null;

    const result = await listArbEvaluationsForReportInSql({
      coadminUid: gated.coadminUid,
      fromIso: range.fromIso,
      toIso: range.toIso,
      playerUid: cleanText(url.searchParams.get('playerUid')) || null,
      mode,
      evaluationResult: cleanText(url.searchParams.get('evaluationResult')) || null,
      tierId: cleanText(url.searchParams.get('tierId')) || null,
      configVersionId: cleanText(url.searchParams.get('configVersionId')) || null,
      skipReason: cleanText(url.searchParams.get('skipReason')) || null,
      eligible,
      search: cleanText(url.searchParams.get('search')) || null,
      limit: Number(url.searchParams.get('limit') || 50),
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
    console.error('[ARB_REPORT_EVALUATIONS]', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to load ARB evaluations.',
      },
      { status: 500 }
    );
  }
}
