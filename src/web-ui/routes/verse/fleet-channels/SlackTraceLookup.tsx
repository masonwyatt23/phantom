import { useRef, useState } from 'react';
import { buildSlackTraceLookupUrl, fetchSlackTraceLookup, DEFAULT_LOOKUP_MAX_AGE_SECONDS, type SlackTraceLookupResult } from './slack-trace-lookup.js';
import { SlackTraceBody } from './SlackTraceCard.js';
import styles from './fleet-channels.module.css';

/** Read-only lookup of one Slack request by channel id and message ts. GET only. */
export function SlackTraceLookup() {
  const [thread, setThread] = useState(''), [channel, setChannel] = useState(''), [message, setMessage] = useState('');
  const [maxAge, setMaxAge] = useState(String(DEFAULT_LOOKUP_MAX_AGE_SECONDS));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SlackTraceLookupResult | null>(null);
  const abort = useRef<AbortController | null>(null);
  const input = { thread, channel, message, maxAgeSeconds: maxAge };
  const built = buildSlackTraceLookupUrl(input);
  const invalid = typeof built !== 'string' ? built.error : null;

  const run = async () => {
    if (invalid || busy) return;
    abort.current?.abort();
    const ctl = abort.current = new AbortController();
    setBusy(true);
    const next = await fetchSlackTraceLookup(input, ctl.signal);
    if (ctl.signal.aborted) return;
    setResult(next);
    setBusy(false);
  };

  const view = result?.ok ? result.view : null;
  return <section className={styles.root} aria-label="Look up a request">
    <strong>Look up a request</strong>
    <form onSubmit={(e) => { e.preventDefault(); void run(); }}>
      <label>Thread ts <input value={thread} onChange={(e) => setThread(e.target.value)} placeholder="1700000000.000100" /></label>
      <label>Channel id <input value={channel} onChange={(e) => setChannel(e.target.value)} placeholder="C00000000" /></label>
      <label>Message ts <input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="optional" /></label>
      <label>Max age (s) <input value={maxAge} onChange={(e) => setMaxAge(e.target.value)} inputMode="numeric" /></label>
      <button type="submit" disabled={invalid !== null || busy}>{busy ? 'Looking up…' : 'Look up'}</button>
    </form>
    {thread !== '' && invalid && <p className={styles.message}>{invalid}</p>}
    {result && !result.ok && <p className={styles.notice} role="alert">{result.error}</p>}
    {view && <div data-testid="slack-trace-lookup-result">
      <p className={styles.header}>{view.freshness
        ? `freshness: ${view.freshness.verdict.toUpperCase()}${view.freshness.maxAgeSeconds ? ` (max ${view.freshness.maxAgeSeconds} s)` : ''}`
        : 'freshness: UNKNOWN'}</p>
      {view.rows.length === 0 && <p className={styles.notice} role="status">No evidence for this request</p>}
      <SlackTraceBody view={view} nowMs={Date.now()} />
      {view.scope && <p className={styles.message}>{view.scope}</p>}
    </div>}
  </section>;
}
