import 'server-only';

import { adminAuth } from '@/lib/firebase/admin';
import { assertValidGameUsername } from '@/lib/games/gameUsernameRule';
import { lookupReferrerByCodeFromSql } from '@/lib/sql/authorityReferralCodes';
import { lookupUserDirectoryFromSql } from '@/lib/sql/authorityLookup';
import { cleanText } from '@/lib/sql/playerMirrorCommon';
import { isActiveUsernameTakenInSql } from '@/lib/sql/userDirectoryWrite';
import { completeCanonicalPlayerCreation } from '@/lib/server/canonicalPlayerCreation';

export type CoadminPlayerCreationInput = {
  username: string;
  password: string;
  ownerCoadminUid: string;
  createdByStaffId?: string | null;
  referralCodeInput?: string | null;
  actorUid: string;
  actorRole: string;
  source?: string;
};

export type CoadminPlayerCreationResult = {
  success: true;
  uid: string;
  username: string;
  email: string;
  referralApplied: boolean;
  referralBonusCoins: number;
  referredByUid: string | null;
  referredByUsername: string | null;
  createdTaskIds: string[];
  referralId: string | null;
};

function makeHiddenEmail(username: string) {
  return `${username}@app.local`;
}

function parseReferralCodeInput(value: unknown) {
  const code = cleanText(value);
  if (!code) return '';
  if (!/^\d{6,10}$/.test(code)) {
    const error = new Error('Invalid referral code.');
    (error as { status?: number }).status = 400;
    throw error;
  }
  return code;
}

export async function createCoadminPlayerAccount(
  input: CoadminPlayerCreationInput
): Promise<CoadminPlayerCreationResult> {
  const username = cleanText(input.username);
  const password = String(input.password || '');
  const ownerCoadminUid = cleanText(input.ownerCoadminUid);
  const createdByStaffId = cleanText(input.createdByStaffId) || null;
  const actorUid = cleanText(input.actorUid);
  const actorRole = cleanText(input.actorRole) || 'internal';
  const source = cleanText(input.source) || 'authority_create_player';
  const referralCodeInput = parseReferralCodeInput(input.referralCodeInput);

  if (!username) {
    const error = new Error('Username is required.');
    (error as { status?: number }).status = 400;
    throw error;
  }
  try {
    assertValidGameUsername(username);
  } catch (error) {
    (error as { status?: number }).status = 400;
    throw error;
  }
  if (password.length < 6) {
    const error = new Error('Password must be at least 6 characters.');
    (error as { status?: number }).status = 400;
    throw error;
  }
  if (!ownerCoadminUid) {
    const error = new Error('coadminUid is required.');
    (error as { status?: number }).status = 400;
    throw error;
  }
  if (!actorUid) {
    const error = new Error('actorUid is required.');
    (error as { status?: number }).status = 400;
    throw error;
  }

  const owner = await lookupUserDirectoryFromSql(ownerCoadminUid);
  if (!owner || cleanText(owner.role).toLowerCase() !== 'coadmin') {
    const error = new Error('Owner coadmin scope is invalid.');
    (error as { status?: number }).status = 403;
    throw error;
  }

  if (await isActiveUsernameTakenInSql(username)) {
    const error = new Error('Username already exists.');
    (error as { status?: number }).status = 409;
    throw error;
  }

  if (referralCodeInput && !(await lookupReferrerByCodeFromSql(referralCodeInput))) {
    const error = new Error('Invalid referral code.');
    (error as { status?: number }).status = 400;
    throw error;
  }

  const email = makeHiddenEmail(username);
  let createdAuthUid: string | null = null;
  try {
    const authUser = await adminAuth.createUser({
      email,
      password,
      displayName: username,
      disabled: false,
    });
    createdAuthUid = authUser.uid;

    const result = await completeCanonicalPlayerCreation({
      uid: authUser.uid,
      username,
      email,
      password,
      ownerCoadminUid,
      createdByStaffId,
      referralCodeInput: referralCodeInput || null,
      actorUid,
      actorRole,
      source,
    });

    createdAuthUid = null;
    return {
      success: true,
      uid: authUser.uid,
      username,
      email,
      referralApplied: result.referralApplied,
      referralBonusCoins: result.referralBonusCoins,
      referredByUid: result.referredByUid,
      referredByUsername: result.referredByUsername,
      createdTaskIds: result.createdTaskIds,
      referralId: result.referralId,
    };
  } catch (error) {
    if (createdAuthUid) {
      await adminAuth.deleteUser(createdAuthUid).catch(() => undefined);
    }
    throw error;
  }
}
