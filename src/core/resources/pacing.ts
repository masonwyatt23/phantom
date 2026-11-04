/**
 * Backward-compatible re-export from the refactored pacing module.
 * The original pacing logic was moved to src/core/resources/pacing/ as part of
 * the receding-horizon solver refactor (#1253). This file redirects imports so
 * existing callers and tests continue to work without changes.
 *
 * @module resources/pacing
 */
export {
  HorizonKnobs, PacePoint, PoolPaceSeries, ReadingStamp, PacePlan,
  safetyBuffer, paceWindow, stubSeries, seriesFromManual,
} from './pacing/index.js';
export type { PaceSolver, PaceSolverOutcome } from './pacing/index.js';

import { planHorizon as planCoreHorizon, type HorizonPlan as CoreHorizonPlan } from './pacing/index.js';

/** Preserve the original API's solver labels while sharing the hardened core. */
export interface HorizonPlan extends Omit<CoreHorizonPlan, 'solver'> {
  solver: 'lp' | 'even';
}

export async function planHorizon(input: Parameters<typeof planCoreHorizon>[0]): Promise<HorizonPlan> {
  const plan = await planCoreHorizon(input);
  return { ...plan, solver: plan.solver === 'highs' ? 'lp' : 'even' };
}
