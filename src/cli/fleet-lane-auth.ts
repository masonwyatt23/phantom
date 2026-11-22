import { formatLaneAuthText, raiseLaneAuthAsks, readLaneAuth, type LaneAuthV1 } from '../core/fleet/lane-auth.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = 'Usage: phm fleet lane-auth [--json]';

export async function cmdFleetLaneAuth(
  args: string[],
  read: () => Promise<LaneAuthV1> = readLaneAuth,
  raise: (data: LaneAuthV1) => Promise<string[]> = raiseLaneAuthAsks,
): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { console.log(USAGE); return 0; }
  if (args.length > 1 || args.some(arg => arg !== '--json')) { console.error(USAGE); return 2; }
  const report = await read();
  await raise(report);
  console.log(args.length ? JSON.stringify(sanitizePublicJson(report)) : formatLaneAuthText(report));
  return 0;
}
