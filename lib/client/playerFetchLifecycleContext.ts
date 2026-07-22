'use client';

let activeLifecycleReason: string | null = null;

export function withPlayerFetchLifecycleReason<T>(
  reason: string,
  fn: () => T | Promise<T>
): Promise<T> {
  const previous = activeLifecycleReason;
  activeLifecycleReason = String(reason || '').trim() || null;
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => {
        activeLifecycleReason = previous;
      });
    }
    activeLifecycleReason = previous;
    return Promise.resolve(result);
  } catch (error) {
    activeLifecycleReason = previous;
    return Promise.reject(error);
  }
}

export function peekPlayerFetchLifecycleReason() {
  return activeLifecycleReason;
}

export function readSnapshotReasonFromFetchUrl(url: string) {
  try {
    const parsed = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    return parsed.searchParams.get('snapshotReason');
  } catch {
    return null;
  }
}
