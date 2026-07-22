'use client';

export function snapshotFetchRequiresFullBody(reason: string) {
  if (reason === 'bootstrap') {
    return true;
  }
  if (reason === 'visibility' || reason === 'stall_timeout' || reason === 'sse_error') {
    return true;
  }
  if (/^reconnect_attempt_/i.test(reason)) {
    return true;
  }
  return false;
}

/** Temporary diagnostic: safe client refetch reason for snapshot URL (max 80 chars). */
export function sanitizeSnapshotReasonParam(reason: unknown): string | null {
  const cleaned = String(reason || '')
    .trim()
    .slice(0, 80)
    .replace(/[^a-zA-Z0-9_.:-]+/g, '_');
  return cleaned || null;
}

export function buildLiveSnapshotPath(
  path: string,
  options: {
    latestOutboxId?: number;
    requireFull?: boolean;
    snapshotReason?: string | null;
  }
) {
  const params = new URLSearchParams();
  if (options.requireFull) {
    params.set('forceFull', '1');
  } else if (
    options.latestOutboxId != null &&
    Number.isFinite(options.latestOutboxId) &&
    options.latestOutboxId >= 0
  ) {
    params.set('latestOutboxId', String(Math.trunc(options.latestOutboxId)));
  }
  const snapshotReason = sanitizeSnapshotReasonParam(options.snapshotReason);
  if (snapshotReason) {
    params.set('snapshotReason', snapshotReason);
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export type SnapshotFetchBody = {
  latestOutboxId?: number;
  unchanged?: boolean;
  ok?: boolean;
  source?: string;
};

export async function parseLiveSnapshotResponse<T extends SnapshotFetchBody>(
  response: Response
): Promise<{ unchanged: boolean; snapshot: T | null }> {
  if (response.status === 304) {
    return { unchanged: true, snapshot: null };
  }
  const snapshot = (await response.json()) as T;
  if (snapshot.unchanged === true || snapshot.source === 'postgres_snapshot_unchanged') {
    return { unchanged: true, snapshot };
  }
  return { unchanged: false, snapshot };
}
