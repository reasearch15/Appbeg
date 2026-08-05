import { NextResponse } from 'next/server';

import type { ArbDraftConfiguration } from '@/lib/economy/automaticRechargeBonus/types';
import {
  arbValidationErrorResponse,
  extractValidation,
  readIdempotencyKey,
  requireArbAdminApi,
} from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import {
  resetArbDraftToDefaultInSql,
  saveArbDraftInSql,
} from '@/lib/sql/authorityAutomaticBonusConfig';

export const runtime = 'nodejs';

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const gated = await requireArbAdminApi(request, {
    requestedCoadminUid: cleanText(body.coadminUid),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  const draft = body.draft as ArbDraftConfiguration | undefined;
  if (!draft || typeof draft !== 'object') {
    return NextResponse.json({ error: 'draft is required.' }, { status: 400 });
  }

  try {
    const result = await saveArbDraftInSql({
      coadminUid: gated.coadminUid,
      draft,
      actorUid: gated.actorUid,
      actorRole: gated.actorRole,
      idempotencyKey: readIdempotencyKey(request, body),
      requireValid: body.requireValid !== false,
    });

    return NextResponse.json({
      success: true,
      duplicate: Boolean(result.duplicate),
      settings: result.settings,
      validation: result.validation,
      source: 'postgres',
    });
  } catch (error) {
    const validation = extractValidation(error);
    if (validation) {
      return arbValidationErrorResponse(
        error instanceof Error ? error.message : 'Draft validation failed.',
        validation
      );
    }
    console.error('[ARB_ADMIN_DRAFT_PUT]', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to save draft.',
      },
      { status: 500 }
    );
  }
}

/** Reset draft to platform default linear tiers (does not publish). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const gated = await requireArbAdminApi(request, {
    requestedCoadminUid: cleanText(body.coadminUid),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  const action = cleanText(body.action) || 'reset_defaults';
  if (action !== 'reset_defaults') {
    return NextResponse.json(
      { error: 'Unsupported draft action. Use action=reset_defaults.' },
      { status: 400 }
    );
  }

  try {
    const result = await resetArbDraftToDefaultInSql({
      coadminUid: gated.coadminUid,
      actorUid: gated.actorUid,
      actorRole: gated.actorRole,
      idempotencyKey: readIdempotencyKey(request, body),
    });

    return NextResponse.json({
      success: true,
      duplicate: Boolean(result.duplicate),
      settings: result.settings,
      validation: result.validation,
      source: 'postgres',
    });
  } catch (error) {
    const validation = extractValidation(error);
    if (validation) {
      return arbValidationErrorResponse(
        error instanceof Error ? error.message : 'Reset validation failed.',
        validation
      );
    }
    console.error('[ARB_ADMIN_DRAFT_RESET]', error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Failed to reset draft.',
      },
      { status: 500 }
    );
  }
}
