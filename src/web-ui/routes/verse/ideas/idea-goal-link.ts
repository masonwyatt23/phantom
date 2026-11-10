/**
 * routes/verse/ideas/idea-goal-link.ts: ties goal-drift ideas to the live
 * goal list, for the Ideas pane's goal chip and Goal filter.
 */
import type { GoalSummary } from '../../../data/queries.js';
import type { IdeaRow } from './ideas-model.js';

const CHIP_OBJECTIVE_MAX = 60;

export function ideaGoalId(idea: IdeaRow): string | null {
  return idea.goal?.id || null;
}

/**
 * Chip text for an idea's goal: the live objective (capped) when the goal is
 * known, else the name the backlog carried, else the bare id.
 */
export function goalChipText(goalId: string | null, goals: readonly GoalSummary[], fallbackName?: string): string | null {
  if (!goalId) return null;
  const objective = goals.find(goal => goal.id === goalId)?.objective;
  if (objective) return `for: ${objective.slice(0, CHIP_OBJECTIVE_MAX)}`;
  return fallbackName && fallbackName !== goalId ? `for: ${fallbackName.slice(0, CHIP_OBJECTIVE_MAX)}` : `for: goal ${goalId}`;
}

export function filterIdeasByGoal(ideas: readonly IdeaRow[], goalId: string | 'all'): IdeaRow[] {
  return goalId === 'all' ? [...ideas] : ideas.filter(idea => ideaGoalId(idea) === goalId);
}
