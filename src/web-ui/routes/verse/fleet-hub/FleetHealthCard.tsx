import type { FleetHealth, HealthDetail } from '../../../../core/fleet/health.js';
import { apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import styles from './fleet-hub.module.css';

export const healthQuery: QueryDef<FleetHealth> = { key: 'fleet-health', fetch: async signal => {
  const report = await apiGet<FleetHealth>('/api/verse/fleet/health', signal);
  if (report?.schema !== 'fleet.health.v1' || !Array.isArray(report.lines) || report.lines.length !== 5) throw new Error('Fleet health unavailable');
  return report;
} };
const labels = { main: 'Main', merges: 'Merges, last hour', pools: 'Unused before reset', families: 'Wasted starts, last 24 hours', releases: 'Unreleased work' };
export function FleetHealthCard({ visible = true, onOpen }: { visible?: boolean; onOpen: (id: HealthDetail) => void }) {
  const documentVisible = useDocumentVisible(), sectionVisible = useSectionVisible();
  const read = useQuery(healthQuery, { enabled: visible && documentVisible && sectionVisible, freshMs: 60_000 });
  const refresh = useRefetch(healthQuery);
  usePollWhileVisible(refresh, 60_000, { enabled: visible });
  const lines = read.status !== 'error' && read.data ? read.data.lines : (Object.keys(labels) as HealthDetail[]).map(id => ({ id,
    text: `${labels[id]}: unknown, because ${read.status === 'error' ? 'the health report could not be refreshed' : 'the health report has not arrived'}.` }));
  return <section className={styles.notRunning} aria-label="Fleet health summary"><h2>Fleet health</h2>
    <ul>{lines.map(line => <li key={line.id}><button type="button" className={styles.secondary} style={{ minHeight: 44, textAlign: 'left', overflowWrap: 'anywhere' }} onClick={() => onOpen(line.id)}>{line.text}</button></li>)}</ul>
  </section>;
}
