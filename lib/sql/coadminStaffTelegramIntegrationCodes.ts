import 'server-only';

import { createHash, randomBytes } from 'crypto';

import { cleanText, getPlayerMirrorPool } from '@/lib/sql/playerMirrorCommon';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PREFIX = 'STG-';

export function normalizeStaffTelegramIntegrationCode(value: unknown) {
  return cleanText(value).toUpperCase().replace(/\s+/g, '');
}

function makeCode() {
  const bytes = randomBytes(12);
  let value = CODE_PREFIX;
  for (const byte of bytes) value += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return value;
}

function codeHash(code: string) {
  return createHash('sha256').update(normalizeStaffTelegramIntegrationCode(code)).digest('hex');
}

async function verifyCoadmin(db: NonNullable<ReturnType<typeof getPlayerMirrorPool>>, uid: string) {
  const result = await db.query(
    `SELECT 1 FROM public.players_cache WHERE uid=$1 AND role='coadmin' AND deleted_at IS NULL LIMIT 1`,
    [uid]
  );
  if (!result.rows.length) throw new Error('Coadmin account was not found.');
}

export async function getOrCreateCoadminStaffTelegramIntegrationCode(coadminUid: string) {
  const db = getPlayerMirrorPool();
  const uid = cleanText(coadminUid);
  if (!db || !uid) throw new Error('Staff Telegram integration codes are temporarily unavailable.');
  await verifyCoadmin(db, uid);
  const existing = await db.query<{ code: string }>(
    `SELECT code FROM public.coadmin_staff_telegram_integration_codes WHERE coadmin_uid=$1 LIMIT 1`,
    [uid]
  );
  if (existing.rows[0]?.code) return normalizeStaffTelegramIntegrationCode(existing.rows[0].code);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = makeCode();
    try {
      const created = await db.query<{ code: string }>(
        `INSERT INTO public.coadmin_staff_telegram_integration_codes (coadmin_uid,code) VALUES ($1,$2)
         ON CONFLICT (coadmin_uid) DO UPDATE SET updated_at=now()
         RETURNING code`,
        [uid, code]
      );
      return normalizeStaffTelegramIntegrationCode(created.rows[0]?.code || code);
    } catch (error) {
      if (attempt === 4) throw error;
    }
  }
  throw new Error('Unable to generate a Staff Telegram Integration Code.');
}

export async function rotateCoadminStaffTelegramIntegrationCode(coadminUid: string) {
  const db = getPlayerMirrorPool();
  const uid = cleanText(coadminUid);
  if (!db || !uid) throw new Error('Staff Telegram integration codes are temporarily unavailable.');
  await verifyCoadmin(db, uid);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ code: string }>(
      `SELECT code FROM public.coadmin_staff_telegram_integration_codes WHERE coadmin_uid=$1 FOR UPDATE`,
      [uid]
    );
    const oldCode = normalizeStaffTelegramIntegrationCode(current.rows[0]?.code || '');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = makeCode();
      await client.query('SAVEPOINT staff_telegram_integration_code_candidate');
      try {
        const result = await client.query<{ code: string }>(
          `INSERT INTO public.coadmin_staff_telegram_integration_codes (coadmin_uid,code,rotated_at)
           VALUES ($1,$2,now())
           ON CONFLICT (coadmin_uid) DO UPDATE SET code=EXCLUDED.code,updated_at=now(),rotated_at=now()
           RETURNING code`,
          [uid, code]
        );
        const nextCode = normalizeStaffTelegramIntegrationCode(result.rows[0]?.code || code);
        await client.query(
          `INSERT INTO public.coadmin_staff_telegram_integration_code_audit (coadmin_uid,old_code_hash,new_code_hash)
           VALUES ($1,NULLIF($2,''),$3)`,
          [uid, oldCode ? codeHash(oldCode) : '', codeHash(nextCode)]
        );
        await client.query('COMMIT');
        return nextCode;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT staff_telegram_integration_code_candidate');
        if (attempt === 4) throw error;
      }
    }
    throw new Error('Unable to rotate the Staff Telegram Integration Code.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveCoadminUidByStaffTelegramIntegrationCode(value: unknown) {
  const db = getPlayerMirrorPool();
  const code = normalizeStaffTelegramIntegrationCode(value);
  if (!db || !code) return null;
  const result = await db.query<{ coadmin_uid: string }>(
    `SELECT c.coadmin_uid
     FROM public.coadmin_staff_telegram_integration_codes c
     INNER JOIN public.players_cache u ON u.uid=c.coadmin_uid AND u.role='coadmin' AND u.deleted_at IS NULL
     WHERE upper(c.code)=upper($1)
     LIMIT 1`,
    [code]
  );
  return result.rows[0]?.coadmin_uid ? cleanText(result.rows[0].coadmin_uid) : null;
}
