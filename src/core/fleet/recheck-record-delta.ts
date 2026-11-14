import type { RecheckRecord } from './recheck-record.js';

export interface RecheckChange {
  field: string;
  from: string;
  to: string;
}

export function diffRecheckRecords(
  prev: RecheckRecord | null,
  next: RecheckRecord
): RecheckChange[] {
  if (prev === null) {
    return [];
  }

  const changes: RecheckChange[] = [];

  // Compare in fixed order
  const compareField = (field: string, fromValue: unknown, toValue: unknown) => {
    const fromStr = fromValue === null ? 'none' : String(fromValue);
    const toStr = toValue === null ? 'none' : String(toValue);
    if (fromStr !== toStr) {
      changes.push({ field, from: fromStr, to: toStr });
    }
  };

  compareField('overall', prev.overall, next.overall);
  compareField('runtime.state', prev.sections.runtime.state, next.sections.runtime.state);
  compareField('runtime.host', prev.sections.runtime.host, next.sections.runtime.host);
  compareField('runtime.installedVersion', prev.sections.runtime.installedVersion, next.sections.runtime.installedVersion);
  compareField('claims.state', prev.sections.claims.state, next.sections.claims.state);
  compareField('claims.active', prev.sections.claims.active, next.sections.claims.active);
  compareField('bridge.state', prev.sections.bridge.state, next.sections.bridge.state);
  compareField('bridge.missingBridge', prev.sections.bridge.missingBridge, next.sections.bridge.missingBridge);
  compareField('task.state', prev.sections.task.state, next.sections.task.state);
  compareField('task.id', prev.sections.task.id, next.sections.task.id);
  compareField('task.owner', prev.sections.task.owner, next.sections.task.owner);
  compareField('task.claimReceipt', prev.sections.task.claimReceipt, next.sections.task.claimReceipt);

  return changes;
}
