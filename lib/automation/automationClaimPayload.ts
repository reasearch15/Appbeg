/**
 * Shared automation payload builders (no Firebase client auth).
 * Used by carer claim flows in the browser and by admin API routes.
 */

export type QueuedAutomationType =
  | 'CREATE_USERNAME'
  | 'RECREATE_USERNAME'
  | 'RECHARGE'
  | 'REDEEM'
  | 'RESET_PASSWORD'
  | 'LOGIN'
  | 'COMPLETE_TASK';

export type AutomationPayload = {
  player: string;
  playerUid?: string | null;
  playerUsername?: string | null;
  game: string;
  loginUrl?: string | null;
  gameLoginUrl?: string | null;
  lobbyUrl?: string | null;
  siteUrl?: string | null;
  baseUrl?: string | null;
  gameCredentialUsername?: string | null;
  gameCredentialPassword?: string | null;
  username: string | null;
  currentUsername: string | null;
  gameAccountUsername?: string | null;
  amount: number | null;
  originalTask: Record<string, unknown>;
};

export type AutomationPayloadInput = {
  taskId: string;
  freshTask: Record<string, unknown>;
  currentUserUid: string;
  currentCarerName: string;
  currentUsername?: string | null;
};

export type GameLoginDetailsInput = {
  username?: string | null;
  password?: string | null;
  backendUrl?: string | null;
  frontendUrl?: string | null;
  siteUrl?: string | null;
} | null;

const DEFAULT_GAME_VAULT_LOGIN_URL = 'https://agent.gamevault999.com/login';
const DEFAULT_ORION_STARS_AGENT_URL = 'https://orionstars.vip:8781/Store.aspx';

export function getTimestampMs(value: unknown) {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    'toMillis' in value &&
    typeof (value as { toMillis?: unknown }).toMillis === 'function'
  ) {
    try {
      return Number((value as { toMillis: () => number }).toMillis()) || 0;
    } catch {
      return 0;
    }
  }
  return 0;
}

export function sanitizeForFirestore(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeForFirestore(entry));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeForFirestore(entry)])
    );
  }
  return value;
}

export function mapTaskType(taskType: string): QueuedAutomationType {
  const normalized = taskType
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toUpperCase()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ');
  if (
    normalized === 'CREATE USERNAME' ||
    normalized === 'CREATE_USERNAME' ||
    normalized === 'CREATE GAME USERNAME'
  ) {
    return 'CREATE_USERNAME';
  }
  if (normalized === 'RECREATE USERNAME' || normalized === 'RECREATE_USERNAME') {
    return 'RECREATE_USERNAME';
  }
  if (normalized === 'RECHARGE') return 'RECHARGE';
  if (normalized === 'REDEEM') return 'REDEEM';
  if (normalized === 'RESET PASSWORD' || normalized === 'RESET_PASSWORD') {
    return 'RESET_PASSWORD';
  }
  if (normalized === 'LOGIN') return 'LOGIN';
  return 'COMPLETE_TASK';
}

export function resolveTaskTypeLabel(task: Record<string, unknown>) {
  const fromTaskType = String(task.type || task.kind || '').trim();
  if (!fromTaskType) {
    return 'COMPLETE_TASK';
  }

  if (fromTaskType.includes('_')) {
    return fromTaskType.replace(/_/g, ' ');
  }
  return fromTaskType;
}

function normalizeUrlValue(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function normalizeTextValue(value: unknown) {
  return String(value || '').trim() || null;
}

function isGameVaultTask(task: Record<string, unknown>) {
  const gameName = String(task.gameName || task.game || '').trim().toLowerCase();
  return gameName === 'game vault';
}

function normalizedAutomationGameKey(task: Record<string, unknown>) {
  return String(task.gameName || task.game || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function isOrionStarsAutomationTask(task: Record<string, unknown>) {
  const key = normalizedAutomationGameKey(task);
  return key === 'orion_stars' || key === 'orionstars';
}

export function resolveAutomationAccessFields(
  task: Record<string, unknown>,
  gameLoginDetails?: GameLoginDetailsInput
) {
  const originalTask =
    task.originalTask && typeof task.originalTask === 'object'
      ? (task.originalTask as Record<string, unknown>)
      : {};

  const resolvedLoginUrl =
    normalizeUrlValue(
      gameLoginDetails?.backendUrl ||
        task.loginUrl ||
        task.gameLoginUrl ||
        task.siteUrl ||
        task.baseUrl ||
        task.lobbyUrl ||
        task.backendUrl ||
        originalTask.loginUrl ||
        originalTask.gameLoginUrl ||
        originalTask.siteUrl ||
        originalTask.baseUrl ||
        originalTask.lobbyUrl ||
        originalTask.backendUrl ||
        gameLoginDetails?.siteUrl
    ) ||
    (isGameVaultTask(task) ? DEFAULT_GAME_VAULT_LOGIN_URL : null) ||
    (isOrionStarsAutomationTask(task) ? DEFAULT_ORION_STARS_AGENT_URL : null);

  const resolvedSiteUrl =
    normalizeUrlValue(
      gameLoginDetails?.siteUrl ||
        gameLoginDetails?.frontendUrl ||
        task.siteUrl ||
        task.frontendUrl ||
        task.baseUrl ||
        task.loginUrl ||
        task.gameLoginUrl ||
        task.backendUrl ||
        originalTask.siteUrl ||
        originalTask.frontendUrl ||
        originalTask.baseUrl ||
        originalTask.loginUrl ||
        originalTask.gameLoginUrl ||
        originalTask.backendUrl
    ) || resolvedLoginUrl;

  const resolvedBaseUrl =
    normalizeUrlValue(
      gameLoginDetails?.backendUrl ||
        task.baseUrl ||
        task.backendUrl ||
        task.siteUrl ||
        task.loginUrl ||
        task.gameLoginUrl ||
        originalTask.baseUrl ||
        originalTask.backendUrl ||
        originalTask.siteUrl ||
        originalTask.loginUrl ||
        originalTask.gameLoginUrl
    ) || resolvedLoginUrl;

  const resolvedLobbyUrl =
    normalizeUrlValue(
      task.lobbyUrl ||
        task.loginUrl ||
        task.gameLoginUrl ||
        originalTask.lobbyUrl ||
        originalTask.loginUrl ||
        originalTask.gameLoginUrl ||
        gameLoginDetails?.backendUrl
    ) || resolvedLoginUrl;

  return {
    loginUrl: resolvedLoginUrl,
    gameLoginUrl:
      normalizeUrlValue(task.gameLoginUrl || originalTask.gameLoginUrl) || resolvedLoginUrl,
    lobbyUrl: resolvedLobbyUrl,
    siteUrl: resolvedSiteUrl,
    baseUrl: resolvedBaseUrl,
    gameCredentialUsername:
      normalizeTextValue(
        gameLoginDetails?.username ||
          task.gameCredentialUsername ||
          task.loginUsername ||
          originalTask.gameCredentialUsername ||
          originalTask.loginUsername
      ) || null,
    gameCredentialPassword:
      normalizeTextValue(
        gameLoginDetails?.password ||
          task.gameCredentialPassword ||
          task.loginPassword ||
          originalTask.gameCredentialPassword ||
          originalTask.loginPassword
      ) || null,
  };
}

function buildOriginalTaskCommon(
  input: AutomationPayloadInput,
  mergedTask: Record<string, unknown>,
  base: Omit<AutomationPayload, 'username' | 'amount' | 'originalTask'>
) {
  return {
    id: input.taskId,
    type: String(mergedTask.type || mergedTask.kind || '').trim() || null,
    kind: String(mergedTask.kind || mergedTask.type || '').trim() || null,
    status: 'in_progress',
    assignedCarerUid: input.currentUserUid,
    assignedCarer: input.currentCarerName,
    playerUid: base.playerUid,
    playerUsername: base.playerUsername,
    currentUsername: base.currentUsername,
    gameAccountUsername: base.gameAccountUsername,
    loginUrl: base.loginUrl,
    gameLoginUrl: base.gameLoginUrl,
    lobbyUrl: base.lobbyUrl,
    siteUrl: base.siteUrl,
    baseUrl: base.baseUrl,
    gameCredentialUsername: base.gameCredentialUsername,
    gameCredentialPassword: base.gameCredentialPassword,
  };
}

export function buildAutomationPayload(input: AutomationPayloadInput): AutomationPayload {
  const mergedTask = {
    id: input.taskId,
    ...input.freshTask,
    status: 'in_progress',
    assignedCarerUid: input.currentUserUid,
    assignedCarer: input.currentCarerName,
    assignedCarerUsername: input.currentCarerName,
    currentUsername: input.currentUsername ?? input.freshTask.currentUsername ?? null,
  } as Record<string, unknown>;
  const mappedType = mapTaskType(resolveTaskTypeLabel(mergedTask));
  const resolvedAccess = resolveAutomationAccessFields(mergedTask);
  const base = {
    player: String(mergedTask.playerUsername || mergedTask.player || 'Player'),
    playerUid: String(mergedTask.playerUid || '').trim() || null,
    playerUsername:
      String(mergedTask.playerUsername || mergedTask.player || '').trim() || null,
    game: String(mergedTask.gameName || mergedTask.game || 'Unknown Game'),
    currentUsername:
      ((mergedTask.currentUsername as string | null | undefined) ??
        (mergedTask.gameAccountUsername as string | null | undefined) ??
        null),
    gameAccountUsername:
      ((mergedTask.gameAccountUsername as string | null | undefined) ??
        (mergedTask.currentUsername as string | null | undefined) ??
        null),
    loginUrl: resolvedAccess.loginUrl,
    gameLoginUrl: resolvedAccess.gameLoginUrl,
    lobbyUrl: resolvedAccess.lobbyUrl,
    siteUrl: resolvedAccess.siteUrl,
    baseUrl: resolvedAccess.baseUrl,
    gameCredentialUsername: resolvedAccess.gameCredentialUsername,
    gameCredentialPassword: resolvedAccess.gameCredentialPassword,
  };

  if (mappedType === 'CREATE_USERNAME') {
    return {
      ...base,
      username: base.currentUsername || base.player || null,
      amount: null,
      originalTask: buildOriginalTaskCommon(input, mergedTask, base),
    };
  }

  if (mappedType === 'RECREATE_USERNAME') {
    return {
      ...base,
      username: base.currentUsername || null,
      amount: null,
      originalTask: buildOriginalTaskCommon(input, mergedTask, base),
    };
  }

  if (mappedType === 'RECHARGE' || mappedType === 'REDEEM') {
    const amountValue = Number(mergedTask.amount);
    return {
      ...base,
      username: base.currentUsername || null,
      amount: Number.isFinite(amountValue) ? amountValue : null,
      originalTask: buildOriginalTaskCommon(input, mergedTask, base),
    };
  }

  if (mappedType === 'RESET_PASSWORD') {
    return {
      ...base,
      username: base.currentUsername || null,
      amount: null,
      originalTask: buildOriginalTaskCommon(input, mergedTask, base),
    };
  }

  return {
    ...base,
    username: base.currentUsername || null,
    amount: null,
    originalTask: buildOriginalTaskCommon(input, mergedTask, base),
  };
}
