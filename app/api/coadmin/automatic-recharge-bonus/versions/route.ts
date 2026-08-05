import { NextResponse } from 'next/server';

import { requireArbAdminApi } from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  listArbConfigVersionsInSql,
  loadArbPublishedConfigurationInSql,
} from '@/lib/sql/authorityAutomaticBonusConfig';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const gated = await requireArbAdminApi(request, {
    requestedCoadminUid: cleanText(url.searchParams.get('coadminUid')),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  const versionId = cleanText(url.searchParams.get('versionId'));
  try {
    if (versionId) {
      const version = await loadArbPublishedConfigurationInSql({
        coadminUid: gated.coadminUid,
        versionId,
      });
      if (!version) {
        return NextResponse.json({ error: 'Version not found.' }, { status: 404 });
      }
      return NextResponse.json({
        success: true,
        version,
        source: 'postgres',
      });
    }

    const versions = await listArbConfigVersionsInSql({
      coadminUid: gated.coadminUid,
      limit: Math.min(
        200,
        Math.max(1, Math.trunc(Number(url.searchParams.get('limit')) || 50))
      ),
    });

    return NextResponse.json({
      success: true,
      versions,
      source: 'postgres',
    });
  } catch (error) {
    console.error('[ARB_ADMIN_VERSIONS]', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to load versions.',
      },
      { status: 500 }
    );
  }
}
