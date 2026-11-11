const KEY = 'phantom.leaderThread.replyDraft.v1';

export function loadLeaderReply(storage: Storage | null): string {
  try {
    const value = storage?.getItem(KEY);
    return typeof value === 'string' ? value : '';
  } catch { return ''; }
}

export function saveLeaderReply(storage: Storage | null, text: string): void {
  try {
    if (!text.trim()) storage?.removeItem(KEY);
    else storage?.setItem(KEY, text.slice(0, 6000));
  } catch { /* Storage may be unavailable or full. */ }
}

export function clearLeaderReply(storage: Storage | null): void {
  try { storage?.removeItem(KEY); } catch { /* Storage may be unavailable. */ }
}
