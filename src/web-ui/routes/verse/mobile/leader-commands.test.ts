import { describe, expect, it, vi } from 'vitest';
import { commandArgError, helpLine } from '../leader-thread/composer-commands.js';
import { runPhoneCommand, type PhoneCommandDeps } from './leader-commands.js';

describe('phone commands', () => {
  it('runs supported commands and reports validation and failures', async () => {
    const deps: PhoneCommandDeps = { status: vi.fn().mockResolvedValue('All clear'), pause: vi.fn().mockRejectedValue(new Error('offline')), resume: vi.fn(), release: vi.fn(), hold: vi.fn() };
    expect(await runPhoneCommand({ name: 'status', arg: '' }, deps)).toBe('All clear');
    expect(await runPhoneCommand({ name: 'hold', arg: 'codex-personal 30' }, deps)).toContain('Held codex-personal');
    expect(deps.hold).toHaveBeenCalledOnce();
    expect(deps.hold).toHaveBeenCalledWith('codex-personal', 30);
    const invalid = { name: 'hold' as const, arg: 'bad' };
    expect(await runPhoneCommand(invalid, deps)).toBe(commandArgError(invalid));
    expect(deps.hold).toHaveBeenCalledOnce();
    expect(await runPhoneCommand({ name: 'drop', arg: 'x' }, deps)).toBe('/drop works in the desktop app.');
    expect(await runPhoneCommand({ name: 'open', arg: 'fleet-lanes' }, deps)).toBe('/open works in the desktop app.');
    expect(await runPhoneCommand({ name: 'pause', arg: '' }, deps)).toBe('/pause failed: offline');
    expect(await runPhoneCommand({ name: 'help', arg: '' }, deps)).toBe(helpLine());
  });
});
