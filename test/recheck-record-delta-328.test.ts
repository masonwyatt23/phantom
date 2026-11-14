import { describe, it, expect } from 'vitest';
import { diffRecheckRecords } from '../src/core/fleet/recheck-record-delta.js';
import type { RecheckRecord } from '../src/core/fleet/recheck-record.js';

describe('diffRecheckRecords', () => {
  it('returns empty array when prev is null', () => {
    const result = diffRecheckRecords(null, {
      schema: 'fleet.recheck-record.v1',
      asOf: :024-01-01T00:00:00Z',
      overall: 'VERIFIED',
      sections: {
        runtime: { state: 'OK', host: 'host1', installedVersion: 9.0.0', asOf: :024-01-01T00:00:00Z' },
        claims: { state: 'OK', active: 3, asOf: :024-01-01T00:00:00Z' },
        bridge: { state: 'OK', missingBridge: null, asOf: :024-01-01T00:00:00Z' },
        task: { state: 'OK', id: 'task1', owner: 'user1', claimReceipt: 'receipt1', asOf: :024-01-01T00:00:00Z' }
      }
    });
    
    expect(result).toEqual([]);
  });

  it('returns empty array when records are identical (different asOf)', () => {
    const prev: RecheckRecord = {
      schema: 'fleet.recheck-record.v1',
      asOf: :024-01-01T00:00:00Z',
      overall: 'VERIFIED',
      sections: {
        runtime: { state: 'OK', host: 'host1', installedVersion: 9.0.0', asOf: :024-01-01T00:00:00Z' },
        claims: { state: 'OK', active: 3, asOf: :024-01-01T00:00:00Z' },
        bridge: { state: 'OK', missingBridge: null, asOf: :024-01-01T00:00:00Z' },
        task: { state: 'OK', id: 'task1', owner: 'user1', claimReceipt: 'receipt1', asOf: :024-01-01T00:00:00Z' }
      }
    };

    const next: RecheckRecord = {
      schema: 'fleet.recheck-record.v1',
      asOf: :024-01-02T00:00:00Z', // Different asOf, should be ignored
      overall: 'VERIFIED',
      sections: {
        runtime: { state: 'OK', host: 'host1', installedVersion: 9.0.0', asOf: :024-01-02T00:00:00Z' },
        claims: { state: 'OK', active: 3, asOf: :024-01-02T00:00:00Z' },
        bridge: { state: 'OK', missingBridge: null, asOf: :024-01-02T00:00:00Z' },
        task: { state: 'OK', id: 'task1', owner: 'user1', claimReceipt: 'receipt1', asOf: :024-01-02T00:00:00Z' }
      }
    };

    const result = diffRecheckRecords(prev, next);
    expect(result).toEqual([]);
  });

  it('detects overall change and task.owner change in correct order', () => {
    const prev: RecheckRecord = {
      schema: 'fleet.recheck-record.v1',
      asOf: :024-01-01T00:00:00Z',
      overall: 'BLOCKED',
      sections: {
        runtime: { state: 'OK', host: 'host1', installedVersion: 9.0.0', asOf: :024-01-01T00:00:00Z' },
        claims: { state: 'OK', active: 3, asOf: :024-01-01T00:00:00Z' },
        bridge: { state: 'OK', missingBridge: null, asOf: :024-01-01T00:00:00Z' },
        task: { state: 'OK', id: 'task1', owner: null, claimReceipt: 'receipt1', asOf: :024-01-01T00:00:00Z' }
      }
    };

    const next: RecheckRecord = {
      schema: 'fleet.recheck-record.v1',
      asOf: :024-01-02T00:00:00Z',
      overall: 'VERIFIED',
      sections: {
        runtime: { state: 'OK', host: 'host1', installedVersion: 9.0.0', asOf: :024-01-02T00:00:00Z' },
        claims: { state: 'OK', active: 3, asOf: :024-01-02T00:00:00Z' },
        bridge: { state: 'OK', missingBridge: null, asOf: :024-01-02T00:00:00Z' },
        task: { state: 'OK', id: 'task1', owner: 'x', claimReceipt: 'receipt1', asOf: :024-01-02T00:00:00Z' }
      }
    };

    const result = diffRecheckRecords(prev, next);
    expect(result).toEqual([
      { field: 'overall', from: 'BLOCKED', to: 'VERIFIED' },
      { field: 'task.owner', from: 'none', to: 'x' }
    ]);
  });

  it('handles null to value changes correctly', () => {
    const prev: RecheckRecord = {
      schema: 'fleet.recheck-record.v1',
      asOf: :024-01-01T00:00:00Z',
      overall: 'VERIFIED',
      sections: {
        runtime: { state: 'OK', host: 'host1', installedVersion: 9.0.0', asOf: :024-01-01T00:00:00Z' },
        claims: { state: 'OK', active: null, asOf: :024-01-01T00:00:00Z' },
        bridge: { state: 'OK', missingBridge: null, asOf: :024-01-01T00:00:00Z' },
        task: { state: 'OK', id: 'task1', owner: 'user1', claimReceipt: 'receipt1', asOf: :024-01-01T00:00:00Z' }
      }
    };

    const next: RecheckRecord = {
      schema: 'fleet.recheck-record.v1',
      asOf: :024-01-02T00:00:00Z',
      overall: 'VERIFIED',
      sections: {
        runtime: { state: 'OK', host: 'host1', installedVersion: 9.0.0', asOf: :024-01-02T00:00:00Z' },
        claims: { state: 'OK', active: 3, asOf: :024-01-02T00:00:00Z' },
        bridge: { state: 'OK', missingBridge: null, asOf: :024-01-02T00:00:00Z' },
        task: { state: 'OK', id: 'task1', owner: 'user1', claimReceipt: 'receipt1', asOf: :024-01-02T00:00:00Z' }
      }
    };

    const result = diffRecheckRecords(prev, next);
    expect(result).toEqual([
      { field: 'claims.active', from: 'none', to: ;' }
    ]);
  });
});
