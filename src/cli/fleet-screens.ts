import { homedir } from 'node:os';
import { join } from 'node:path';
import { listLeaderScreens } from '../core/fleet/leader-screens.js';

const usage = 'Usage: ashlr fleet screens [--limit <1-200>] [--since <24h|7d|ISO>] [--json]';

export async function cmdFleetScreens(args: string[], deps: { runsDir?: string; output?: (text: string) => void; error?: (text: string) => void } = {}): Promise<number> {
  const output = deps.output ?? console.log;
  const error = deps.error ?? console.error;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { output(usage); return 0; }
  let limit = 20;
  let since: Date | undefined;
  let json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) return invalid();
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--limit' || arg === '--since') {
      const value = args[++i];
      if (!value || value.startsWith('--')) return invalid();
      if (arg === '--limit') {
        if (!/^\d{1,3}$/.test(value) || Number(value) < 1 || Number(value) > 200) return invalid();
        limit = Number(value);
      } else {
        if (value === '24h' || value === '7d') since = new Date(Date.now() - (value === '24h' ? 24 : 168) * 3600000);
        else {
          if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) return invalid();
          since = new Date(value);
          if (!Number.isFinite(since.getTime())) return invalid();
        }
      }
    } else return invalid();
  }
  const result = listLeaderScreens({ runsDir: deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), limit, since });
  if (json) output(JSON.stringify(result));
  else for (const screen of result.screens) output(`${new Date(screen.takenAt).toLocaleString()}  ${screen.bytes} B  ${(screen.caption ?? '(no inbox line)').replace(/\s+/g, ' ')}  ${screen.path}`);
  return 0;
  function invalid(): number { error(`error: invalid arguments. ${usage}`); return 2; }
}
