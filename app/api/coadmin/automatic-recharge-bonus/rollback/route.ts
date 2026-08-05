import { NextResponse } from 'next/server';

import {
  extractValidation,
  arbValidationErrorResponse,
  readIdempotencyKey,
  requireArbAdminApi,
} from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { rollbackArbConfigInSql } from '@/lib/sql/authorityAutomaticBonusConfig';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const gated = await requireArbAdminApi(request, {
    requestedCoadminUid: cleanText(body.coadminUid),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  const targetVersionId = cleanText(body.targetVersionId || body.versionId);
  if (!targetVersionId) {
    return NextResponse.json(
      { error: 'targetVersionId is required.' },
      { status: 400 }
    );
  }

  try {
    const result = await rollbackArbConfigInSql({
      coadminUid: gated.coadminUid,
      targetVersionId,
      actorUid: gated.actorUid,
      actorRole: gated.actorRole,
      idempotencyKey: readIdempotencyKey(request, body),
      loadDraftFromTarget: body.loadDraftFromTarget !== false,
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
        error instanceof Error ? error.message : 'Rollback failed.',
        validation
      );
    }
    console.error('[ARB_ADMIN_ROLLBACK]', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to roll back configuration.',
      },
      { status: 500 }
    );
  }
}
