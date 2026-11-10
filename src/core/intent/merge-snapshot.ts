import { linkMergedPull, type MergedPullNote } from './evidence.js';
import { validRepo } from './schema.js';
import { transactIntentLedger } from './store.js';

/** Serialize merge observations with other intent ledger writers. */
export async function noteMergeSnapshot(pulls: MergedPullNote[], root: string, at: string): Promise<void> {
  await transactIntentLedger(root, (ledger) => {
    for (const pull of pulls) {
      if (!validRepo(pull.repo) || !Number.isSafeInteger(pull.number) || pull.number < 1) continue;
      const ref = `${pull.repo}#${pull.number}`.toLowerCase();
      // Evidence is the durable receipt even when the bounded PR list is full.
      const items = ledger.items.filter(item => !item.evidence.some(row => row.kind === 'pr' && row.ref.toLowerCase() === ref));
      const statuses = new Map(items.map(item => [item, item.status]));
      const matched = linkMergedPull({ items }, pull, at);
      for (const item of matched) {
        const previous = statuses.get(item)!;
        if (previous !== 'queued' && previous !== 'in-progress') item.status = previous;
      }
    }
  });
}
