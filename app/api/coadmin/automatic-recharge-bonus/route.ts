import { NextResponse } from 'next/server';

import {
  arbValidationErrorResponse,
  extractValidation,
  requireArbAdminOrReportingApi,
} from '@/lib/server/arbCoadminApi';
import { getAutomaticRechargeBonusFlagStatus } from '@/lib/server/automaticRechargeBonusFlags';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  ensureArbSettingsInSql,
  listArbConfigVersionsInSql,
  loadArbPublishedConfigurationInSql,
  loadArbSettingsInSql,
} from '@/lib/sql/authorityAutomaticBonusConfig';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const gated = await requireArbAdminOrReportingApi(request, {
    requestedCoadminUid: cleanText(url.searchParams.get('coadminUid')),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  try {
    let settings = await loadArbSettingsInSql({ coadminUid: gated.coadminUid });
    if (!settings) {
      settings = await ensureArbSettingsInSql({ coadminUid: gated.coadminUid });
    }

    const [published, versions] = await Promise.all([
      loadArbPublishedConfigurationInSql({ coadminUid: gated.coadminUid }),
      listArbConfigVersionsInSql({
        coadminUid: gated.coadminUid,
        limit: Math.min(
          100,
          Math.max(1, Math.trunc(Number(url.searchParams.get('versionLimit')) || 40))
        ),
      }),
    ]);

    return NextResponse.json({
      success: true,
      settings,
      published,
      versions,
      flags: getAutomaticRechargeBonusFlagStatus(),
      source: 'postgres',
    });
  } catch (error) {
    const validation = extractValidation(error);
    if (validation) {
      return arbValidationErrorResponse(
        error instanceof Error ? error.message : 'ARB request failed.',
        validation
      );
    }
    console.error('[ARB_ADMIN_GET]', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to load Automatic Recharge Bonus settings.',
      },
      { status: 500 }
    );
  }
}
