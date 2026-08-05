import { NextResponse } from 'next/server';

import { requireArbAdminApi } from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { listArbSettingsAuditInSql } from '@/lib/sql/authorityAutomaticBonusConfig';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const gated = await requireArbAdminApi(request, {
    requestedCoadminUid: cleanText(url.searchParams.get('coadminUid')),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  try {
    const entries = await listArbSettingsAuditInSql({
      coadminUid: gated.coadminUid,
      limit: Math.min(
        200,
        Math.max(1, Math.trunc(Number(url.searchParams.get('limit')) || 50))
      ),
    });

    return NextResponse.json({
      success: true,
      entries,
      source: 'postgres',
    });
  } catch (error) {
    console.error('[ARB_ADMIN_AUDIT]', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to load audit history.',
      },
      { status: 500 }
    );
  }
}
