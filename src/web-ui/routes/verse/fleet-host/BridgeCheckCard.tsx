import { useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { bridgeCheckHeadline, parseBridgeCheck, type ParsedBridgeCheck } from './bridge-check-model.js';
import { bridgeCheckQuery } from './bridge-check-query.js';
import { formatAge } from './runtime-identity-model.js';
import { snapshotAge } from './tailnet-peers-model.js';
import styles from './fleet-host.module.css';

export function BridgeCheckBody({ parsed, now }: { parsed: ParsedBridgeCheck; now?: number }) {
  const [clock, setClock] = useState(Date.now);
  usePollWhileVisible(() => setClock(Date.now()), 5_000);
  const headline = bridgeCheckHeadline(parsed);
  const elapsed = parsed.kind === 'ok' ? snapshotAge(parsed.asOf, now ?? clock) : 'unknown';
  return <>
    <h3 className={styles.title}>Cloud bridge</h3>
    <p className={styles.line} data-tone={headline.tone === 'danger' ? 'bad' : headline.tone} role="status">
      {headline.text}{' '}
      {parsed.kind === 'ok' ? <span className={styles.muted}>as of {formatAge(elapsed)}</span> : null}
    </p>
    {parsed.kind === 'ok' ? <>
      {parsed.reason !== null && headline.tone === 'danger' ? <p className={styles.muted}>{parsed.reason}</p> : null}
      {parsed.sections.map(s => <p className={styles.muted} key={s.name}>{s.text}</p>)}
    </> : null}
  </>;
}

export function BridgeCheckCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const read = useQuery(bridgeCheckQuery, { enabled: visible && sectionVisible && documentVisible, freshMs: 30_000 });
  const refetch = useRefetch(bridgeCheckQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  return <section className={styles.section} aria-label="Cloud bridge check">
    {read.status === 'error' ? <p className={styles.muted}>Bridge check unknown: read failed</p>
      : read.data === null ? <p className={styles.muted}>Bridge check: not served by this build (update Phantom)</p>
      : read.data === undefined ? <p className={styles.muted} role="status">Reading bridge check…</p>
      : <BridgeCheckBody parsed={parseBridgeCheck(read.data)} />}
  </section>;
}
