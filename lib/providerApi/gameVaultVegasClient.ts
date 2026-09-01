import 'server-only';

import { createHash } from 'crypto';

import {
  assertProviderApiConfigured,
  type ProviderApiConfig,
} from '@/lib/providerApi/gameVaultVegasConfig';
import { classifyProviderApiResponse } from '@/lib/providerApi/gameVaultVegasErrors';
import { cleanText } from '@/lib/sql/playerMirrorCommon';

export type ProviderApiOperation =
  | 'addUser'
  | 'recharge'
  | 'withdraw'
  | 'userBalance'
  | 'agentBalance'
  | 'getUserID'
  | 'getLowDepositUsers'
  | 'resetPassword'
  | 'playerOffline';

type ProviderApiRequest = Record<string, string | number | boolean | null | undefined>;

const OPERATION_PATHS: Record<ProviderApiOperation, string> = {
  addUser: '/api/external/addUser',
  recharge: '/api/external/recharge',
  withdraw: '/api/external/withdraw',
  userBalance: '/api/external/userBalance',
  agentBalance: '/api/external/agentBalance',
  getUserID: '/api/external/getUserID',
  getLowDepositUsers: '/api/external/external/getLowDepositUsers',
  resetPassword: '/api/external/resetPassword',
  playerOffline: '/api/external/playerOffline',
};

export type ProviderApiCallResult = {
  ok: boolean;
  operation: ProviderApiOperation;
  url: string;
  code: string;
  message: string;
  failureClass: string;
  retryable: boolean;
  moneyRetrySafe: boolean;
  raw: Record<string, unknown>;
};

function timestamp(config: ProviderApiConfig) {
  const ms = Date.now();
  return config.timestampUnit === 'milliseconds' ? String(ms) : String(Math.floor(ms / 1000));
}

function signature(agentId: string, ts: string, secretKey: string) {
  return createHash('md5').update(`${agentId}:${ts}:${secretKey}`).digest('hex').toUpperCase();
}

function appendFormValue(form: FormData, key: string, value: string | number | boolean | null | undefined) {
  if (value === null || value === undefined) return;
  form.append(key, String(value));
}

function redactRaw(raw: Record<string, unknown>) {
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (/password|secret|sign/i.test(key)) {
      copy[key] = '[redacted]';
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

export class GameVaultVegasApiClient {
  constructor(private readonly config: ProviderApiConfig) {}

  async call(operation: ProviderApiOperation, fields: ProviderApiRequest = {}): Promise<ProviderApiCallResult> {
    assertProviderApiConfigured(this.config);
    const ts = timestamp(this.config);
    const form = new FormData();
    appendFormValue(form, 'agent_id', this.config.agentId);
    appendFormValue(form, 'timestamp', ts);
    appendFormValue(form, 'sign', signature(this.config.agentId, ts, this.config.secretKey));
    for (const [key, value] of Object.entries(fields)) {
      appendFormValue(form, key, value);
    }

    const path = OPERATION_PATHS[operation];
    const url = `${this.config.baseUrl}${path}`;
    const response = await fetch(url, { method: 'POST', body: form, cache: 'no-store' });
    let raw: Record<string, unknown>;
    try {
      raw = (await response.json()) as Record<string, unknown>;
    } catch {
      raw = { code: String(response.status), message: await response.text() };
    }
    const classification = classifyProviderApiResponse({
      code: raw.code ?? raw.status,
      message: raw.message ?? raw.msg,
    });
    return {
      ok: response.ok && classification.failureClass === 'success',
      operation,
      url,
      code: classification.code,
      message: classification.message,
      failureClass: classification.failureClass,
      retryable: classification.retryable,
      moneyRetrySafe: classification.moneyRetrySafe,
      raw: redactRaw(raw),
    };
  }

  agentBalance() {
    return this.call('agentBalance');
  }

  getUserId(username: string) {
    return this.call('getUserID', { username: cleanText(username) });
  }

  userBalance(username: string) {
    return this.call('userBalance', { username: cleanText(username) });
  }
}
