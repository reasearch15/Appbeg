import 'server-only';

import { NextResponse } from 'next/server';

import {
  apiError,
  requireApiUser,
  scopedCoadminUid,
  type ApiUser,
} from '@/lib/firebase/apiAuth';
import { isArbAdminEnabled, isArbReportingEnabled } from '@/lib/server/automaticRechargeBonusFlags';
import { isDatabaseUrlConfigured } from '@/lib/server/sqlRuntime';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import type { ArbValidationResult } from '@/lib/economy/automaticRechargeBonus/types';

export function resolveArbCoadminUid(authUser: ApiUser, requestedCoadminUid?: string) {
  if (authUser.role === 'coadmin') {
    return authUser.uid;
  }
  if (authUser.role === 'admin') {
    return cleanText(requestedCoadminUid) || scopedCoadminUid(authUser) || '';
  }
  return '';
}

export async function requireArbAdminApi(
  request: Request,
  options?: { requestedCoadminUid?: string }
) {
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return { errorResponse: auth.response } as const;
  }
  if (!isArbAdminEnabled()) {
    return {
      errorResponse: apiError(
        'Automatic Recharge Bonus administration is disabled (ARB_ADMIN_ENABLED).',
        503
      ),
    } as const;
  }
  if (!isDatabaseUrlConfigured()) {
    return {
      errorResponse: apiError('SQL authority unavailable.', 503),
    } as const;
  }

  const coadminUid = resolveArbCoadminUid(auth.user, options?.requestedCoadminUid);
  if (!coadminUid) {
    return { errorResponse: apiError('Forbidden.', 403) } as const;
  }

  return {
    user: auth.user,
    coadminUid,
    actorUid: auth.user.uid,
    actorRole: auth.user.role,
  } as const;
}

/**
 * Read-only reporting gate (Phase 8).
 * Does not require ARB_ADMIN_ENABLED — ops can view reports without config write access.
 */
export async function requireArbReportingApi(
  request: Request,
  options?: { requestedCoadminUid?: string }
) {
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return { errorResponse: auth.response } as const;
  }
  if (!isArbReportingEnabled()) {
    return {
      errorResponse: apiError(
        'Automatic Recharge Bonus reporting is disabled (ARB_REPORTING_ENABLED).',
        503
      ),
    } as const;
  }
  if (!isDatabaseUrlConfigured()) {
    return {
      errorResponse: apiError('SQL authority unavailable.', 503),
    } as const;
  }

  const coadminUid = resolveArbCoadminUid(auth.user, options?.requestedCoadminUid);
  if (!coadminUid) {
    return { errorResponse: apiError('Forbidden.', 403) } as const;
  }

  return {
    user: auth.user,
    coadminUid,
    actorUid: auth.user.uid,
    actorRole: auth.user.role,
  } as const;
}

/** GET shell: allow admin config OR reporting read access. */
export async function requireArbAdminOrReportingApi(
  request: Request,
  options?: { requestedCoadminUid?: string }
) {
  const auth = await requireApiUser(request, ['admin', 'coadmin']);
  if ('response' in auth) {
    return { errorResponse: auth.response } as const;
  }
  if (!isArbAdminEnabled() && !isArbReportingEnabled()) {
    return {
      errorResponse: apiError(
        'Automatic Recharge Bonus is disabled (ARB_ADMIN_ENABLED or ARB_REPORTING_ENABLED).',
        503
      ),
    } as const;
  }
  if (!isDatabaseUrlConfigured()) {
    return {
      errorResponse: apiError('SQL authority unavailable.', 503),
    } as const;
  }

  const coadminUid = resolveArbCoadminUid(auth.user, options?.requestedCoadminUid);
  if (!coadminUid) {
    return { errorResponse: apiError('Forbidden.', 403) } as const;
  }

  return {
    user: auth.user,
    coadminUid,
    actorUid: auth.user.uid,
    actorRole: auth.user.role,
    adminEnabled: isArbAdminEnabled(),
    reportingEnabled: isArbReportingEnabled(),
  } as const;
}

export function arbValidationErrorResponse(
  message: string,
  validation: ArbValidationResult,
  status = 400
) {
  return NextResponse.json(
    {
      error: message,
      validation,
    },
    { status }
  );
}

export function readIdempotencyKey(request: Request, body?: Record<string, unknown>) {
  const header = cleanText(request.headers.get('Idempotency-Key'));
  if (header) return header;
  return cleanText(body?.idempotencyKey);
}

export function extractValidation(error: unknown): ArbValidationResult | null {
  if (!error || typeof error !== 'object') return null;
  const validation = (error as { validation?: ArbValidationResult }).validation;
  if (!validation || typeof validation !== 'object') return null;
  if (!Array.isArray(validation.errors)) return null;
  return validation;
}
