import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import { listStaffTelegramSubscribersForCoadmin } from '@/lib/server/staffTelegramSubscribersLedger';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireApiUser(request, ['coadmin']);
  if ('response' in auth) return auth.response;

  try {
    const subscribers = await listStaffTelegramSubscribersForCoadmin(auth.user.uid);
    return NextResponse.json({ subscribers });
  } catch (error) {
    console.error('[COADMIN_STAFF_TELEGRAM_SUBSCRIBERS] list failed', {
      coadminUid: auth.user.uid,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Unable to load connected Telegram staff right now.' },
      { status: 503 }
    );
  }
}
