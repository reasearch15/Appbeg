import { NextResponse } from 'next/server';

import { verifyAgentTickSecret } from '@/lib/automation/agentApiAuth';
import { apiError } from '@/lib/firebase/apiAuth';
import { GameVaultVegasApiClient } from '@/lib/providerApi/gameVaultVegasClient';
import {
  getProviderApiConfig,
  resolveProviderApiGameKey,
} from '@/lib/providerApi/gameVaultVegasConfig';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  if (!verifyAgentTickSecret(request)) {
    return apiError('Unauthorized.', 401);
  }

  const url = new URL(request.url);
  const gameKey = resolveProviderApiGameKey(url.searchParams.get('game') || 'game_vault');
  if (!gameKey) {
    return apiError('game must be Game Vault or Vegas Sweeps.', 400);
  }

  const username = String(url.searchParams.get('username') || '').trim();
  const config = getProviderApiConfig(gameKey);
  const client = new GameVaultVegasApiClient(config);

  try {
    const checks = [await client.agentBalance()];
    if (username) {
      checks.push(await client.getUserId(username), await client.userBalance(username));
    }
    return NextResponse.json({
      ok: checks.every((check) => check.ok),
      game: config.label,
      executionMode: config.executionMode,
      mutationsEnabled: config.mutationsEnabled,
      orderIdIdempotencyVerified: config.orderIdIdempotencyVerified,
      checks,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return apiError(message, 500);
  }
}
