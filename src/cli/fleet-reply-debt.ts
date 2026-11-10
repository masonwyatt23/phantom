import { computeReplyDebt } from '../core/fleet/leader-reply-debt.js';
import { readInboxEntries } from '../core/fleet/mason-inbox.js';
import { readOutboxEntries } from '../core/fleet/mason-outbox.js';

export async function cmdFleetReplyDebt(args: string[]): Promise<number> {
  const [inbox, outbox] = await Promise.all([
    readInboxEntries({ limit: Number.MAX_SAFE_INTEGER }),
    readOutboxEntries({ limit: Number.MAX_SAFE_INTEGER }),
  ]);
  const result = { ...computeReplyDebt(inbox.entries, outbox.entries, new Date()), sourceStates: { inbox: inbox.sourceState, outbox: outbox.sourceState } };
  if (args.includes('--json')) console.log(JSON.stringify(result));
  else {
    console.log(`Leader owes Mason ${result.owed.length} replies, oldest ${result.oldestAgeMinutes ?? 0} min`);
    for (const row of result.owed.slice(0, 5)) console.log(`${row.at} ${row.source}: ${row.preview}`);
  }
  return 0;
}
