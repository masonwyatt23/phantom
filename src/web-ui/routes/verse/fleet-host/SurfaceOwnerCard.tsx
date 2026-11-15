import { Fragment } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { useDocumentVisible, usePollWhileVisible, useSectionVisible } from '../shell/section-visibility.js';
import { surfaceOwnerRows, surfaceOwnersQuery } from './surface-owner-query.js';
import styles from './fleet-host.module.css';

export function SurfaceOwnerCard({ visible }: { visible: boolean }) {
  const sectionVisible = useSectionVisible();
  const documentVisible = useDocumentVisible();
  const enabled = visible && sectionVisible && documentVisible;
  const read = useQuery(surfaceOwnersQuery, { enabled, freshMs: 30_000 });
  const refetch = useRefetch(surfaceOwnersQuery);
  usePollWhileVisible(refetch, 30_000, { enabled: visible, refreshOnShow: false });
  const view = surfaceOwnerRows(read.data, read.error);
  return <section className={styles.section} aria-label="Owners">
    <h3 className={styles.title}>Owners</h3>
    {view.note ? <p className={styles.muted} role="status">{view.note}</p> : null}
    <dl className={styles.identity}>
      {view.rows.map((row, index) => <Fragment key={`${index}:${row.surface}`}>
        <dt>{row.surface}</dt>
        <dd><span className={styles.badge} data-tone={row.tone}>{row.ownerText}</span>{' '}
          <span className={styles.muted}>{row.landedText}</span></dd>
      </Fragment>)}
    </dl>
  </section>;
}
