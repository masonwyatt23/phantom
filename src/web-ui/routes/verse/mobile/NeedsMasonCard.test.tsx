import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMutationToken, clearMutationToken } from '../../../data/auth-store.js';
import { apiGet, apiPost } from '../../../data/client.js';
import { AUTO_RESOLVE_REPLY } from '../shell/needs-mason-triage-model.js';
import { resetGuard } from '../shell/guard-store.js';
import { NeedsMasonCard } from './NeedsMasonCard.js';
import { MobileGuardSheet } from './MobileGuardSheet.js';
import { MobileToasts, resetMobileToastsForTest } from './mobile-toast.js';
import { TOKEN } from './mobile.test-support.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn(), apiPost: vi.fn() }));
const rows = [{ id: 'nm-000000000001', text: 'Password required' }, { id: 'nm-000000000002', text: 'unpark RQ-ONE' }, { id: 'nm-000000000003', text: 'unpark RQ-TWO' }];
beforeEach(() => { resetGuard(); resetMobileToastsForTest(); setMutationToken(TOKEN); });
afterEach(() => { resetGuard(); clearMutationToken(); });
function mount(onClearChange = vi.fn()) {
  render(<><NeedsMasonCard canAct offline={false} onClearChange={onClearChange} /><MobileGuardSheet /><MobileToasts /></>);
  return onClearChange;
}
describe('NeedsMasonCard', () => {
  it('groups items and resolves the batch through one confirmation', async () => {
    vi.mocked(apiGet).mockResolvedValue({ items: rows });
    vi.mocked(apiPost).mockResolvedValue({});
    const report = mount();
    expect(await screen.findByText('Hard limit: secrets or authentication')).toBeInTheDocument();
    expect(screen.getByText('Outside the hard limits (2)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resolve all 2' }));
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Resolve all 2' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
    expect(vi.mocked(apiPost).mock.calls.map(call => call[1])).toEqual(rows.slice(1).map(row => ({ itemId: row.id, reply: AUTO_RESOLVE_REPLY })));
    expect(await screen.findByText('Resolved 2, 0 already resolved, 0 failed')).toBeInTheDocument();
    expect(report).toHaveBeenLastCalledWith(false);
  });
  it('reports a failed read as not clear', async () => {
    vi.mocked(apiGet).mockRejectedValue(new Error('offline'));
    const report = mount();
    expect(await screen.findByText('Can’t reach the Mac')).toBeInTheDocument();
    expect(report).toHaveBeenLastCalledWith(false);
    expect(screen.queryByText('All clear')).not.toBeInTheDocument();
  });
});
