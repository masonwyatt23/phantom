import { checkPrRecut, type PrRecutCheckDeps } from '../core/fleet/pr-recut-check.js';
import { sanitizePublicJson } from '../core/util/public-json.js';
import { scrubSecrets } from '../core/util/scrub.js';

const usage = 'usage: phm fleet recut-check <n> [--repo owner/name] [--json]';

export async function cmdFleetRecutCheck(args: string[], deps: PrRecutCheckDeps = {}): Promise<number> {
  let number: string | undefined, repo = 'ashlrai/phantom', json = false, seenRepo = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--repo' && !seenRepo && args[i + 1] && !args[i + 1]!.startsWith('-')) {
      seenRepo = true; repo = args[++i]!;
    } else if (!arg.startsWith('-') && number === undefined) number = arg;
    else { console.error(usage); return 2; }
  }
  const pr = Number(number);
  if (!number || !/^[1-9][0-9]*$/.test(number) || !Number.isSafeInteger(pr)
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    || repo.split('/').some(part => part === '.' || part === '..')) {
    console.error(usage); return 2;
  }
  const report = await checkPrRecut(pr, repo, deps);
  const safe = sanitizePublicJson(report);
  console.log(scrubSecrets(json ? JSON.stringify(safe) : JSON.stringify(safe, null, 2)));
  return report.alreadyOnMaster === null ? 1 : 0;
}
