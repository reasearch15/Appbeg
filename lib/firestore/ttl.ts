const DAY_MS = 24 * 60 * 60 * 1000;

export const AUTOMATION_JOB_TTL_DAYS = 14;
export const COMPLETED_CARER_TASK_TTL_DAYS = 30;
export const CHAT_MESSAGE_TTL_DAYS = 90;
export const COMPLETED_PLAYER_GAME_REQUEST_TTL_DAYS = 90;

export function ttlFromNow(days: number) {
  return new Date(Date.now() + days * DAY_MS);
}

export function automationJobTtl() {
  return ttlFromNow(AUTOMATION_JOB_TTL_DAYS);
}

export function completedCarerTaskTtl() {
  return ttlFromNow(COMPLETED_CARER_TASK_TTL_DAYS);
}

export function chatMessageTtl() {
  return ttlFromNow(CHAT_MESSAGE_TTL_DAYS);
}

export function completedPlayerGameRequestTtl() {
  return ttlFromNow(COMPLETED_PLAYER_GAME_REQUEST_TTL_DAYS);
}
