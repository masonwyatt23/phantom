import { unansweredRows } from '../mobile/leader-unanswered-model.js';
import { setLeaderDraft } from './leader-draft-store.js';
import styles from './leader-thread.module.css';

export function UnansweredStrip({ runs, nowMs }: { runs: unknown; nowMs: number }) {
  const rows = unansweredRows(runs, nowMs);
  if (!rows.length) return null;
  return <section className={styles.note} aria-label="Waiting on the Leader">
    <strong>Waiting on the Leader ({rows.length})</strong>
    <ul>{rows.map((row, index) => <li key={`${row.at}-${index}`}>
      <span>{row.age} · {row.text}</span>{' '}
      <button type="button" onClick={() => setLeaderDraft(row.askAgain)}>Ask again</button>
    </li>)}</ul>
  </section>;
}
