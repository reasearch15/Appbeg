#!/usr/bin/env node

const { Pool } = require('pg');

function clean(value) {
  return String(value || '').trim();
}

function requireEnv(name) {
  const value = clean(process.env[name]);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

async function main() {
  const baseUrl = clean(process.env.APPBEG_BASE_URL) || 'http://localhost:3000';
  const token = requireEnv('APPBEG_LEDGER_INTERNAL_TOKEN');
  const coadminUid = requireEnv('TEST_COADMIN_UID');
  const username = clean(process.env.TEST_LEDGER_USERNAME) || `Ledger${Date.now()}`;
  const password = clean(process.env.TEST_LEDGER_PASSWORD) || 'password';
  const referralCode = clean(process.env.TEST_REFERRAL_CODE);
  const databaseUrl = clean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
  if (!databaseUrl) {
    throw new Error('DATABASE_URL or POSTGRES_URL is required.');
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const activeGames = await pool.query(
      `SELECT id, game_name
       FROM public.game_logins_cache
       WHERE coadmin_uid = $1 AND status = 'active'
       ORDER BY game_name`,
      [coadminUid]
    );
    if (!activeGames.rows.length) {
      throw new Error(
        `No active game_logins_cache rows found for coadmin ${coadminUid}; create-player has no game seed from which to create a carer username task.`
      );
    }

    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/internal/ledger/create-player`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-appbeg-ledger-token': token,
      },
      body: JSON.stringify({
        username,
        password,
        referralCode: referralCode || undefined,
        coadminUid,
        ledgerContactId: Number(process.env.TEST_LEDGER_CONTACT_ID || 31),
        telegramUserId: clean(process.env.TEST_TELEGRAM_USER_ID) || 'verify-ledger-script',
      }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok || !payload.playerUid) {
      throw new Error(`Ledger create-player failed: HTTP ${response.status} ${JSON.stringify(payload)}`);
    }

    const playerUid = clean(payload.playerUid);
    const [player, credentials, balance, tasks, gameUsername] = await Promise.all([
      pool.query(
        `SELECT uid, username, role, status, created_by, coadmin_uid, coin, cash, promo_locked_coins,
                referred_by_uid, referred_by_code, referral_reward_status, source
         FROM public.players_cache
         WHERE uid = $1 AND deleted_at IS NULL`,
        [playerUid]
      ),
      pool.query(
        `SELECT uid, password_hash, password_algo, must_reset
         FROM public.user_credentials
         WHERE uid = $1`,
        [playerUid]
      ),
      pool.query(
        `SELECT firebase_id, username, role, status, coadmin_uid, created_by, coin, cash, promo_locked_coins
         FROM public.user_balance_snapshots_cache
         WHERE firebase_id = $1 AND deleted_at IS NULL`,
        [playerUid]
      ),
      pool.query(
        `SELECT firebase_id, coadmin_uid, type, status, player_uid, player_username, game_name,
                retry_pending, source
         FROM public.carer_tasks_cache
         WHERE player_uid = $1
           AND coadmin_uid = $2
           AND type = 'create_game_username'
           AND status = 'pending'
           AND deleted_at IS NULL
         ORDER BY game_name`,
        [playerUid, coadminUid]
      ),
      pool.query(
        `SELECT username, game, player_uid, coadmin_uid, status, source
         FROM public.game_usernames
         WHERE player_uid = $1
           AND coadmin_uid = $2
           AND lower(username) = lower($3)
           AND status = 'active'
         LIMIT 1`,
        [playerUid, coadminUid, username]
      ),
    ]);

    const failures = [];
    const playerRow = player.rows[0];
    if (!playerRow) failures.push('missing players_cache row');
    if (playerRow && playerRow.username !== username) failures.push('players_cache username mismatch');
    if (playerRow && playerRow.coadmin_uid !== coadminUid) failures.push('players_cache coadmin_uid mismatch');
    if (playerRow && playerRow.created_by !== coadminUid) failures.push('players_cache created_by mismatch');
    if (!credentials.rows[0]) failures.push('missing user_credentials row');
    if (credentials.rows[0] && !credentials.rows[0].password_hash) {
      failures.push('user_credentials password_hash is empty');
    }
    if (!balance.rows[0]) failures.push('missing user_balance_snapshots_cache row');
    if (!gameUsername.rows[0]) failures.push('missing active game_usernames row');
    if (tasks.rows.length < activeGames.rows.length) {
      failures.push(
        `expected at least ${activeGames.rows.length} pending create_game_username task(s), found ${tasks.rows.length}`
      );
    }

    if (failures.length) {
      throw new Error(`Ledger create-player verification failed: ${failures.join('; ')}`);
    }

    console.log(JSON.stringify({
      ok: true,
      playerUid,
      username,
      coadminUid,
      activeGameCount: activeGames.rows.length,
      pendingCreateUsernameTaskCount: tasks.rows.length,
      taskIds: tasks.rows.map((row) => row.firebase_id),
      referralApplied: Boolean(playerRow.referred_by_uid || playerRow.referred_by_code),
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
