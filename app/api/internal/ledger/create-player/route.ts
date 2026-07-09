import { NextResponse } from 'next/server';

import { createCoadminPlayerAccount } from '@/lib/server/coadminPlayerCreation';

export const runtime = 'nodejs';

function errorStatus(error: unknown) {
  const status = Number((error as { status?: unknown })?.status || 0);
  if (status >= 400 && status < 600) return status;
  return 500;
}

function authorized(request: Request) {
  const expected = String(process.env.APPBEG_LEDGER_INTERNAL_TOKEN || '').trim();
  if (!expected) {
    return { ok: false as const, status: 500, error: 'Internal API token is not configured.' };
  }
  const provided = String(request.headers.get('x-appbeg-ledger-token') || '').trim();
  if (!provided || provided !== expected) {
    return { ok: false as const, status: 401, error: 'Unauthorized.' };
  }
  return { ok: true as const };
}

export async function POST(request: Request) {
  const auth = authorized(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const coadminUid = String(body.coadminUid || '').trim();
    const result = await createCoadminPlayerAccount({
      username: String(body.username || '').trim(),
      password: String(body.password || ''),
      ownerCoadminUid: coadminUid,
      referralCodeInput: String(body.referralCode || '').trim() || null,
      actorUid: coadminUid,
      actorRole: 'ledger',
      source: 'appbeg_ledger',
    });

    console.info('[LEDGER_CREATE_PLAYER]', {
      playerUid: result.uid,
      username: result.username,
      coadminUid,
      ledgerContactId: body.ledgerContactId,
      telegramUserId: String(body.telegramUserId || '').trim() || null,
      taskCount: result.createdTaskIds.length,
      referralApplied: result.referralApplied,
    });

    return NextResponse.json({
      ok: true,
      playerUid: result.uid,
      username: result.username,
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to create player.',
      },
      { status: errorStatus(error) }
    );
  }
}
