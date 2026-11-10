import { useEffect, useState } from 'react';
import { APP_VERSION } from '../sections/app-version.js';
import { replayWhatsNew } from '../onboarding/onboarding-store.js';
import { dismissUpdated, updatedNotice } from './updated-once-model.js';

export function UpdatedNotice() {
  const [notice, setNotice] = useState<{ from: string; to: string } | null>(null);
  useEffect(() => {
    try {
      const next = updatedNotice(window.localStorage, APP_VERSION);
      if (next) setNotice(next);
    } catch { /* Storage may be unavailable. */ }
  }, []);
  if (!notice) return null;
  return <div role="status">Phantom updated from {notice.from} to {notice.to}.{' '}
    <button type="button" onClick={replayWhatsNew}>What's new</button>{' '}
    <button type="button" onClick={() => { try { dismissUpdated(window.localStorage, notice.to); } catch { /* unavailable */ } setNotice(null); }}>Dismiss</button>
  </div>;
}
