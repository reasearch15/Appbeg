import { createHash } from 'crypto';
import { NextResponse } from 'next/server';

import {
  normalizeStaffTelegramIntegrationCode,
  resolveCoadminUidByStaffTelegramIntegrationCode,
} from '@/lib/sql/coadminStaffTelegramIntegrationCodes';
import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

export const runtime = 'nodejs';

const LOOKUP_EVENT = 'staff_telegram_code_lookup';
const LOOKUP_LIMIT_PER_HOUR = 10;

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

function clientIp(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

async function logLookupEvent(request: Request, details: Record<string, unknown> = {}) {
  const db = getPlayerMirrorPool();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO public.player_signup_events (signup_id,event_type,email,username,ip_hash,details)
       VALUES (NULL,$1,NULL,NULL,$2,$3::jsonb)`,
      [LOOKUP_EVENT, digest(clientIp(request)), JSON.stringify(details)]
    );
  } catch (error) {
    console.warn('[STAFF_TELEGRAM_VALIDATE_CODE] lookup_event_log_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function enforceLookupRateLimit(request: Request) {
  const db = getPlayerMirrorPool();
  if (!db) throw new Error('VALIDATION_UNAVAILABLE');
  const result = await db.query(
    `SELECT count(*)::int AS count FROM public.player_signup_events
      WHERE event_type = $1 AND ip_hash = $2 AND created_at > now() - interval '1 hour'`,
    [LOOKUP_EVENT, digest(clientIp(request))]
  );
  if (Number(result.rows[0]?.count || 0) >= LOOKUP_LIMIT_PER_HOUR) {
    throw new Error('RATE_LIMITED');
  }
}

export async function POST(request: Request) {
  const auth = authorized(request);
  if (!auth.ok) {
    return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const code = normalizeStaffTelegramIntegrationCode(body.code);

    try {
      await enforceLookupRateLimit(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === 'RATE_LIMITED') {
        await logLookupEvent(request, { outcome: 'rate_limited' });
        return NextResponse.json({ ok: false, error: 'RATE_LIMITED' }, { status: 429 });
      }
      return NextResponse.json({ ok: false, error: 'UNAVAILABLE' }, { status: 503 });
    }

    await logLookupEvent(request, { outcome: 'lookup', codePrefix: code.slice(0, 4) || null });

    if (!code) {
      return NextResponse.json({ ok: false, error: 'INVALID_CODE' }, { status: 400 });
    }

    const coadminUid = await resolveCoadminUidByStaffTelegramIntegrationCode(code);
    if (!coadminUid) {
      return NextResponse.json({ ok: false, error: 'INVALID_CODE' }, { status: 400 });
    }

    return NextResponse.json({
      ok: true,
      coadminUid: cleanText(coadminUid),
    });
  } catch (error) {
    console.error('[STAFF_TELEGRAM_VALIDATE_CODE] failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ ok: false, error: 'UNAVAILABLE' }, { status: 503 });
  }
}
