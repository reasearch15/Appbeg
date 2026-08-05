import { NextResponse } from 'next/server';

import {
  arbValidationErrorResponse,
  extractValidation,
  readIdempotencyKey,
  requireArbAdminApi,
} from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { publishArbDraftInSql } from '@/lib/sql/authorityAutomaticBonusConfig';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const gated = await requireArbAdminApi(request, {
    requestedCoadminUid: cleanText(body.coadminUid),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  try {
    const result = await publishArbDraftInSql({
      coadminUid: gated.coadminUid,
      actorUid: gated.actorUid,
      actorRole: gated.actorRole,
      idempotencyKey: readIdempotencyKey(request, body),
      acceptGapWarnings: body.acceptGapWarnings === true,
    });

    return NextResponse.json({
      success: true,
      duplicate: Boolean(result.duplicate),
      version: result.version,
      settings: result.settings,
      source: 'postgres',
    });
  } catch (error) {
    const validation = extractValidation(error);
    if (validation) {
      return arbValidationErrorResponse(
        error instanceof Error ? error.message : 'Publish validation failed.',
        validation
      );
    }
    console.error('[ARB_ADMIN_PUBLISH]', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to publish configuration.',
      },
      { status: 500 }
    );
  }
}
