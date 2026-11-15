import { setTimeout as delay } from 'node:timers/promises';
import { heartbeatRoot, heartbeatStatus, runFastHeartbeat, type FastOptions } from '../core/heartbeat/fast.js';
import { readFastHeartbeatDigest } from '../core/heartbeat/deep.js';

const USAGE = 'Usage: phm heartbeat status|tick|watch|digest [--json]';
export async function cmdHeartbeat(args: string[], options: FastOptions = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(USAGE); return 0; }
  const [verb, ...flags] = args;
  if (!verb || !['status', 'tick', 'watch', 'digest'].includes(verb) || flags.length > 1 || flags.some(f => f !== '--json')) {
    console.error(USAGE); return 2;
  }
  const root = options.runsDir ?? heartbeatRoot();
  const now = options.now ?? Date.now;
  const print = (value: unknown): void => { console.log(JSON.stringify(value, null, flags.includes('--json') ? undefined : 2)); };
  if (verb === 'status') { print(heartbeatStatus(root, now())); return 0; }
  if (verb === 'digest') { print(readFastHeartbeatDigest(root, now())); return 0; }
  if (verb === 'tick') { print(await runFastHeartbeat(options)); return 0; }
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  options.signal?.addEventListener('abort', stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
    while (!controller.signal.aborted) {
      const result = await runFastHeartbeat({ ...options, signal: controller.signal });
      if (result.status !== 'not_due' && result.status !== 'busy') print(result);
      const status = heartbeatStatus(root, now());
      const untilDue = status.last_tick ? Date.parse(status.last_tick) + status.interval_s * 1000 - now() : 60_000;
      // Model latency must not lengthen the configured interval.
      const waitMs = untilDue > 0 ? Math.min(60_000, untilDue) : 60_000;
      await delay(waitMs, undefined, { signal: controller.signal }).catch(() => {});
    }
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
    options.signal?.removeEventListener('abort', stop);
  }
  return 0;
}
