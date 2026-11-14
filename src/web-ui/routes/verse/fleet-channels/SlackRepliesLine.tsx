import { formatRelative } from '../autonomy/format.js';
import { narrowSlackReplies, slackRepliesLine } from './slack-replies-model.js';
import styles from './fleet-channels.module.css';

/** Answered vs unanswered Slack asks under the channel-health strip. Read-only; nothing when absent. */
export function SlackRepliesLine({ raw, nowMs }: { raw: unknown; nowMs: number }) {
  const view = narrowSlackReplies(raw);
  const line = slackRepliesLine(view, nowMs);
  if (line === null) return null;
  return <div data-testid="slack-replies">
    <p className={styles.message}>{line}</p>
    {view.kind === 'ok' && view.sample.length > 0 && <ul className={styles.healthStrip} aria-label="Unanswered Slack threads">
      {view.sample.map(s => <li key={`${s.channelId}:${s.threadTs}`} className={styles.healthRow}>
        <code>{s.channelId}</code> <code>{s.threadTs}</code> <span>{formatRelative(s.at, nowMs)}</span>
      </li>)}
    </ul>}
  </div>;
}
