import { NextResponse } from 'next/server';

import type { ArbOperationalState } from '@/lib/economy/automaticRechargeBonus/types';
import {
  arbValidationErrorResponse,
  extractValidation,
  readIdempotencyKey,
  requireArbAdminApi,
} from '@/lib/server/arbCoadminApi';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { updateArbOperationalStateInSql } from '@/lib/sql/authorityAutomaticBonusConfig';

export const runtime = 'nodejs';

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const gated = await requireArbAdminApi(request, {
    requestedCoadminUid: cleanText(body.coadminUid),
  });
  if ('errorResponse' in gated) return gated.errorResponse;

  const operational = (body.operational || body) as Partial<ArbOperationalState> &
    Record<string, unknown>;

  const patch: Partial<ArbOperationalState> = {};
  if (typeof operational.featureEnabled === 'boolean') {
    patch.featureEnabled = operational.featureEnabled;
  }
  if (typeof operational.emergencyDisable === 'boolean') {
    patch.emergencyDisable = operational.emergencyDisable;
  }
  if (typeof operational.playerOptInAllowed === 'boolean') {
    patch.playerOptInAllowed = operational.playerOptInAllowed;
  }

  if (
    patch.featureEnabled === undefined &&
    patch.emergencyDisable === undefined &&
    patch.playerOptInAllowed === undefined
  ) {
    return NextResponse.json(
      {
        error:
          'Provide at least one of featureEnabled, emergencyDisable, playerOptInAllowed.',
      },
      { status: 400 }
    );
  }

  try {
    const settings = await updateArbOperationalStateInSql({
      coadminUid: gated.coadminUid,
      operational: patch,
      actorUid: gated.actorUid,
      actorRole: gated.actorRole,
      idempotencyKey: readIdempotencyKey(request, body),
    });

    return NextResponse.json({
      success: true,
      settings,
      source: 'postgres',
    });
  } catch (error) {
    const validation = extractValidation(error);
    if (validation) {
      return arbValidationErrorResponse(
        error instanceof Error ? error.message : 'Operational update failed.',
        validation
      );
    }
    console.error('[ARB_ADMIN_OPERATIONAL]', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : 'Failed to update operational settings.',
      },
      { status: 500 }
    );
  }
}
