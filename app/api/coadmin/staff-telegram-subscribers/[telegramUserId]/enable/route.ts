import { NextResponse } from 'next/server';

import { requireApiUser } from '@/lib/firebase/apiAuth';
import { enableStaffTelegramSubscriberForCoadmin } from '@/lib/server/staffTelegramSubscribersLedger';

export const runtime = 'nodejs';

type RouteContext = {
  params: Promise<{ telegramUserId: string }> | { telegramUserId: string };
};

export async function POST(request: Request, context: RouteContext) {
  const auth = await requireApiUser(request, ['coadmin']);
  if ('response' in auth) return auth.response;

  const resolved = await Promise.resolve(context.params);
  const telegramUserId = String(resolved?.telegramUserId || '').trim();
  if (!telegramUserId) {
    return NextResponse.json({ error: 'telegramUserId is required.' }, { status: 400 });
  }

  try {
    const subscriber = await enableStaffTelegramSubscriberForCoadmin(
      auth.user.uid,
      telegramUserId
    );
    return NextResponse.json({ ok: true, subscriber });
  } catch (error) {
    const status = Number((error as { status?: unknown })?.status || 0);
    console.error('[COADMIN_STAFF_TELEGRAM_SUBSCRIBERS] enable failed', {
      coadminUid: auth.user.uid,
      error: error instanceof Error ? error.message : String(error),
    });
    if (status === 404) {
      return NextResponse.json({ error: 'Telegram staff member was not found.' }, { status: 404 });
    }
    return NextResponse.json(
      { error: 'Unable to enable Telegram staff right now.' },
      { status: 503 }
    );
  }
}
