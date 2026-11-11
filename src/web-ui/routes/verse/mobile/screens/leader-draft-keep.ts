const KEY = 'phantom.mobile.leaderDraft.v1';
const MAX_LENGTH = 6000;

export function loadPhoneLeaderDraft(storage: Storage | null): string {
  try { return (storage?.getItem(KEY) ?? '').slice(0, MAX_LENGTH); } catch { return ''; }
}

export function savePhoneLeaderDraft(storage: Storage | null, text: string): void {
  try {
    if (text.trim()) storage?.setItem(KEY, text.slice(0, MAX_LENGTH));
    else storage?.removeItem(KEY);
  } catch { /* Storage can be unavailable in private browsing. */ }
}

export function clearPhoneLeaderDraft(storage: Storage | null): void {
  try { storage?.removeItem(KEY); } catch { /* Storage can be unavailable. */ }
}
