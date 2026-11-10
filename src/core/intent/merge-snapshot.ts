import { carriedKeys, findByKeys, linkMergedPull, type MergedPullNote } from './evidence.js';
import { MAX_PRS, pullKey, validRepo } from './schema.js';
import { readLedger, writeLedger } from './store.js';

/** Persist new merge observations without rewriting an unchanged private ledger. */
export async function noteMergeSnapshot(pulls: MergedPullNote[], root: string, at: string): Promise<void> {
  const ledger = await readLedger(root);
  let changed = false;
  for (const pull of pulls) {
    if (!validRepo(pull.repo) || !Number.isSafeInteger(pull.number) || pull.number < 1) continue;
    const ref = `${pull.repo}#${pull.number}`.toLowerCase();
    const known = [...new Set(ledger.items.flatMap(item => item.rq))];
    const keys = [...new Set([...carriedKeys(pull.title, known), ...carriedKeys(pull.branch ?? '', known)])];
    const withReceipt = findByKeys(ledger, keys).filter(item =>
      item.evidence.some(row => row.kind === 'pr' && row.ref.toLowerCase() === ref));
    for (const item of withReceipt) {
      const existing = item.prs.find(row => pullKey(row) === ref);
      const needsPull = existing ? existing.state !== 'merged' || (!!pull.url && !existing.url) : item.prs.length < MAX_PRS;
      const needsStatus = item.status === 'queued' || item.status === 'in-progress';
      if (!needsPull && !needsStatus) continue;
      if (Number.isNaN(Date.parse(at))) throw new Error('Time must be an ISO timestamp.');
      if (existing) {
        existing.state = 'merged';
        if (pull.url && !existing.url) existing.url = pull.url;
      } else if (item.prs.length < MAX_PRS) {
        item.prs.push({ repo: pull.repo, number: pull.number, state: 'merged', ...(pull.url ? { url: pull.url } : {}) });
      }
      if (needsStatus) item.status = 'merged';
      item.lastTouchedAt = at;
      item.updatedAt = at;
      changed = true;
    }
    // Keep the durable receipt even when the bounded PR list is full.
    const items = ledger.items.filter(item => !item.evidence.some(row => row.kind === 'pr' && row.ref.toLowerCase() === ref));
    const statuses = new Map(items.map(item => [item, item.status]));
    const matched = linkMergedPull({ items }, pull, at);
    for (const item of matched) {
      const previous = statuses.get(item)!;
      if (previous !== 'queued' && previous !== 'in-progress') item.status = previous;
    }
    if (matched.length) changed = true;
  }
  if (changed) await writeLedger(ledger, root);
}
