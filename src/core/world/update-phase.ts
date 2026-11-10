import { readInstalledBundleVersion, type AppUpdateStatus } from '../app-update-status.js';

/** World/Observe update-check phase: `ok` once the installed app identity is readable, even with an update deferred. */
export function updatePhaseFromStatus(status: Pick<AppUpdateStatus, 'current'>): 'ok' | 'unknown' {
  return typeof status.current === 'string' ? 'ok' : 'unknown';
}

/**
 * The phase needs only the installed bundle version, so the default reader is the
 * read-only Info.plist probe. It deliberately skips the staged-update inspection in
 * readAppUpdateStatus, which reads the real account home and verifies signed stages:
 * too heavy and not hermetic for every world-model build.
 */
export function readUpdatePhase(
  read: () => Pick<AppUpdateStatus, 'current'> = () => ({ current: readInstalledBundleVersion() }),
): 'ok' | 'unknown' {
  try {
    return updatePhaseFromStatus(read());
  } catch {
    return 'unknown';
  }
}
