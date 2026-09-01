import 'server-only';

import { cleanText } from '@/lib/sql/playerMirrorCommon';

export type ProviderApiFailureClass =
  | 'success'
  | 'agent_configuration_error'
  | 'user_error'
  | 'player_in_game'
  | 'manual_review'
  | 'retryable_provider_error'
  | 'unknown_provider_error';

export type ProviderApiFailure = {
  code: string;
  message: string;
  failureClass: ProviderApiFailureClass;
  retryable: boolean;
  moneyRetrySafe: boolean;
  existingReasonCode?: string;
};

const CODE_CLASS: Record<string, Omit<ProviderApiFailure, 'code' | 'message'>> = {
  '0': { failureClass: 'success', retryable: false, moneyRetrySafe: true },
  '1': { failureClass: 'agent_configuration_error', retryable: false, moneyRetrySafe: false },
  '2': { failureClass: 'user_error', retryable: false, moneyRetrySafe: false },
  '3': { failureClass: 'agent_configuration_error', retryable: false, moneyRetrySafe: false },
  '4': { failureClass: 'agent_configuration_error', retryable: false, moneyRetrySafe: false },
  '5': { failureClass: 'agent_configuration_error', retryable: false, moneyRetrySafe: false },
  '6': { failureClass: 'agent_configuration_error', retryable: false, moneyRetrySafe: false },
  '7': {
    failureClass: 'user_error',
    retryable: false,
    moneyRetrySafe: false,
    existingReasonCode: 'fake_redeem',
  },
  '8': { failureClass: 'user_error', retryable: false, moneyRetrySafe: false },
  '9': { failureClass: 'user_error', retryable: false, moneyRetrySafe: false },
  '10': {
    failureClass: 'player_in_game',
    retryable: false,
    moneyRetrySafe: false,
    existingReasonCode: 'PLAYER_IN_GAME',
  },
  '11': { failureClass: 'user_error', retryable: false, moneyRetrySafe: false },
  '12': { failureClass: 'retryable_provider_error', retryable: true, moneyRetrySafe: false },
  '13': { failureClass: 'agent_configuration_error', retryable: false, moneyRetrySafe: false },
  '14': { failureClass: 'retryable_provider_error', retryable: true, moneyRetrySafe: false },
  '16': { failureClass: 'manual_review', retryable: false, moneyRetrySafe: false },
  '17': { failureClass: 'agent_configuration_error', retryable: false, moneyRetrySafe: false },
  '18': { failureClass: 'user_error', retryable: false, moneyRetrySafe: false },
  '19': { failureClass: 'agent_configuration_error', retryable: false, moneyRetrySafe: false },
  '20': { failureClass: 'user_error', retryable: false, moneyRetrySafe: false },
  '21': { failureClass: 'retryable_provider_error', retryable: true, moneyRetrySafe: false },
  '400': { failureClass: 'agent_configuration_error', retryable: false, moneyRetrySafe: false },
};

export function classifyProviderApiResponse(input: {
  code?: unknown;
  message?: unknown;
  status?: unknown;
}): ProviderApiFailure {
  const code = cleanText(input.code ?? input.status);
  const message = cleanText(input.message) || (code ? `Provider returned code ${code}.` : 'Provider error.');
  const known = CODE_CLASS[code];
  if (known) {
    return { code, message, ...known };
  }
  return {
    code: code || 'unknown',
    message,
    failureClass: 'unknown_provider_error',
    retryable: false,
    moneyRetrySafe: false,
  };
}

export function providerApiSucceeded(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return classifyProviderApiResponse({
    code: record.code ?? record.status,
    message: record.message ?? record.msg,
  }).failureClass === 'success';
}
