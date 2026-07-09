import {
  ensureAppSessionBootstrapped,
  getAppSessionRequestHeaders,
} from '@/features/auth/appSession';

export type ApiAuthHeaderAction =
  | 'delete'
  | 'status'
  | 'reset_password'
  | 'create'
  | 'read'
  | 'update'
  | 'api_request';

export async function getApiAuthHeaders(
  contentType = true,
  options?: { action?: ApiAuthHeaderAction }
) {
  await ensureAppSessionBootstrapped();

  const appSessionHeaders = getAppSessionRequestHeaders();
  const hasAppSession = Boolean(appSessionHeaders['X-App-Session-Id']);

  if (options?.action) {
    console.info('[ADMIN_ACTION_AUTH]', {
      action: options.action,
      hasAppSession,
      hasFirebaseUser: false,
      authSource: 'app_session_sql',
    });
  }

  if (!hasAppSession) {
    throw new Error('Not authenticated.');
  }

  return {
    ...(contentType ? { 'Content-Type': 'application/json' } : {}),
    ...appSessionHeaders,
  };
}

export async function getFirebaseApiHeaders(contentType = true) {
  return getApiAuthHeaders(contentType);
}
