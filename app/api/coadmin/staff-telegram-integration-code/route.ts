import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import {
  getOrCreateCoadminStaffTelegramIntegrationCode,
  rotateCoadminStaffTelegramIntegrationCode,
} from '@/lib/sql/coadminStaffTelegramIntegrationCodes';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireApiUser(request, ['coadmin']);
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({
      code: await getOrCreateCoadminStaffTelegramIntegrationCode(auth.user.uid),
    });
  } catch (error) {
    console.error('[COADMIN_STAFF_TELEGRAM_INTEGRATION_CODE] load failed', {
      coadminUid: auth.user.uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        error:
          'Staff Telegram Integration Code is temporarily unavailable. Please try again later.',
      },
      { status: 503 }
    );
  }
}

export async function POST(request: Request) {
  const auth = await requireApiUser(request, ['coadmin']);
  if ('response' in auth) return auth.response;
  try {
    return NextResponse.json({
      code: await rotateCoadminStaffTelegramIntegrationCode(auth.user.uid),
    });
  } catch (error) {
    console.error('[COADMIN_STAFF_TELEGRAM_INTEGRATION_CODE] rotation failed', {
      coadminUid: auth.user.uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      {
        error:
          'Unable to generate a new Staff Telegram Integration Code. Please try again later.',
      },
      { status: 503 }
    );
  }
}
