import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function assertIncludes(relativePath, expected) {
  const body = read(relativePath);
  if (!body.includes(expected)) {
    throw new Error(`${relativePath} is missing expected text: ${expected}`);
  }
}

assertIncludes('lib/providerApi/gameVaultVegasClient.ts', "createHash('md5')");
assertIncludes('lib/providerApi/gameVaultVegasClient.ts', '/api/external/recharge');
assertIncludes('lib/providerApi/gameVaultVegasClient.ts', '/api/external/withdraw');
assertIncludes('lib/providerApi/gameVaultVegasConfig.ts', 'orderIdIdempotencyVerified');
assertIncludes('lib/providerApi/gameVaultVegasErrors.ts', "existingReasonCode: 'PLAYER_IN_GAME'");
assertIncludes('migrations/073_game_vault_vegas_provider_api.sql', 'provider_api_transactions');
assertIncludes('app/api/internal/provider-api/verify/route.ts', 'verifyAgentTickSecret');

console.log('provider API foundation checks passed');
