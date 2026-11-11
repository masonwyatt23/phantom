import { commandArgError, helpLine, holdArgs, type ComposerCommandName } from '../leader-thread/composer-commands.js';
import { fetchLeaderStatusNow } from '../leader-thread/leader-status-now.js';
import { describeActionError } from '../shell/guard-store.js';
import { releaseLaneHold, refreshFleetReads } from './fleet-actions.js';
import { getMobileFleetClient } from './fleet-client.js';

export interface PhoneCommand { name: ComposerCommandName; arg: string }
export interface PhoneCommandDeps {
  status: () => Promise<string | null>;
  pause: () => Promise<unknown>;
  resume: () => Promise<unknown>;
  release: (lane: string) => Promise<unknown>;
  hold?: (lane: string, minutes: number) => Promise<unknown>;
}

export const livePhoneCommandDeps: PhoneCommandDeps = {
  status: fetchLeaderStatusNow,
  pause: async () => { await getMobileFleetClient().daemon('pause'); refreshFleetReads(); },
  resume: async () => { await getMobileFleetClient().daemon('resume'); refreshFleetReads(); },
  release: async lane => { await releaseLaneHold(lane); refreshFleetReads(); },
};

export async function runPhoneCommand(command: PhoneCommand, deps: PhoneCommandDeps): Promise<string> {
  try {
    const error = commandArgError(command);
    if (error) return error;
    switch (command.name) {
      case 'status': return await deps.status() ?? 'Status is unavailable right now.';
      case 'help': return helpLine();
      case 'pause': await deps.pause(); return 'Fleet paused.';
      case 'resume': await deps.resume(); return 'Fleet resumed.';
      case 'release': await deps.release(command.arg); return `${command.arg} hold released.`;
      case 'hold': {
        if (!deps.hold) return '/hold works in the desktop app.';
        const args = holdArgs(command.arg)!;
        await deps.hold(args.lane, args.minutes);
        return `Held ${args.lane} for ${args.minutes} min.`;
      }
      default: return `/${command.name} works in the desktop app.`;
    }
  } catch (error) {
    return `/${command.name} failed: ${describeActionError(error)}`;
  }
}
