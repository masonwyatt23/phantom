import { useCallback, useEffect, useRef, useState } from 'react';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { AUTO_RESOLVE_REPLY, batchResolveSummary, groupNeedsMasonRows, hardLimitChip, type NeedsMasonTriageRow } from '../shell/needs-mason-triage-model.js';
import { runMobileAction } from './mobile-actions.js';
import { showMobileToast } from './mobile-toast.js';
import { Button } from './ui.js';

const PATH = '/api/verse/agent-bus/needs-mason';

type ReadState = 'loading' | 'ready' | 'forbidden' | 'unreachable';

export function NeedsMasonCard({ canAct, offline, onClearChange }: {
  canAct: boolean; offline: boolean; onClearChange: (clear: boolean) => void;
}) {
  const [items, setItems] = useState<NeedsMasonTriageRow[]>([]);
  const [state, setState] = useState<ReadState>('loading');
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const read = useCallback(() => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    apiGet<{ items: unknown }>(PATH, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(result.items) || !result.items.every(row => row && typeof row.id === 'string' && typeof row.text === 'string')) {
        setState('unreachable'); return;
      }
      setItems(result.items as NeedsMasonTriageRow[]);
      setState('ready');
    }).catch(error => {
      if (!controller.signal.aborted) setState(error instanceof ApiError && error.status === 403 ? 'forbidden' : 'unreachable');
    });
  }, []);
  useEffect(() => { read(); return () => abort.current?.abort(); }, [read]);
  usePollWhileVisible(read, 15_000);
  useEffect(() => { onClearChange(!offline && state === 'ready' && items.length === 0); }, [items.length, offline, onClearChange, state]);

  async function resolve(id: string, reply?: string): Promise<'ok' | 'duplicate' | 'failed'> {
    try {
      const token = getMutationToken();
      if (!token) throw new Error('Actions are locked.');
      await apiPost(`${PATH}/resolve`, reply ? { itemId: id, reply } : { itemId: id }, token);
      touchMutationHold();
      return 'ok';
    } catch (error) {
      return error instanceof ApiError && (error.status === 404 || error.status === 409) ? 'duplicate' : 'failed';
    }
  }
  function act(rows: NeedsMasonTriageRow[], batch: boolean) {
    runMobileAction({
      title: batch ? `Resolve all ${rows.length}?` : 'Resolve this item?',
      consequences: batch ? 'Records a reply for each item outside the hard limits.' : 'Records this resolution on your Mac.',
      confirmLabel: batch ? `Resolve all ${rows.length}` : 'Resolve',
      run: async () => {
        setBusy(true);
        const counts = { ok: 0, duplicate: 0, failed: 0 };
        const removed = new Set<string>();
        try {
          for (const row of rows) {
            const result = await resolve(row.id, batch ? AUTO_RESOLVE_REPLY : replies[row.id]?.trim());
            counts[result]++;
            if (result !== 'failed') removed.add(row.id);
          }
          abort.current?.abort();
          setItems(previous => previous.filter(row => !removed.has(row.id)));
          showMobileToast(batchResolveSummary(counts), counts.failed ? 'danger' : 'success');
        } finally { setBusy(false); }
      },
    });
  }
  const grouped = groupNeedsMasonRows(items);
  const disabled = !canAct || offline || state !== 'ready' || busy;
  return <section aria-label="Needs Mason">
    {offline || state === 'unreachable' ? <p>Can’t reach the Mac</p> : state === 'forbidden' ? <p>This phone can’t resolve these</p> : state === 'loading' ? <p>Loading Needs Mason…</p> : null}
    {grouped.hardLimit.map(row => <article key={row.id}>
      <p>{hardLimitChip(row.reason)}</p><p>{row.text}</p>
      <label>Optional reply<input value={replies[row.id] ?? ''} maxLength={500} onChange={event => setReplies(previous => ({ ...previous, [row.id]: event.target.value }))} /></label>
      <Button disabled={disabled} onClick={() => act([row], false)}>Resolve</Button>
    </article>)}
    {grouped.auto.length > 0 && <article><p>Outside the hard limits ({grouped.auto.length})</p>
      <Button disabled={disabled} onClick={() => act(grouped.auto, true)}>Resolve all {grouped.auto.length}</Button>
    </article>}
  </section>;
}
