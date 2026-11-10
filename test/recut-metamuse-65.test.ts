// Recut of #4352 (RQ-PHX-IDEAGOALLINK13): the Ideas pane names each goal-drift
// idea by its live goal objective and filters the list to one open goal.
import { expect, it } from 'vitest';
import type { GoalSummary } from '../src/web-ui/data/queries.js';
import type { VerseBacklogItem } from '../src/web-ui/routes/verse/autonomy/control-queries.js';
import { openGoals } from '../src/web-ui/routes/verse/goals-pane/goals-pane-model.js';
import { filterIdeasByGoal, goalChipText, ideaGoalId } from '../src/web-ui/routes/verse/ideas/idea-goal-link.js';
import { rankIdeas } from '../src/web-ui/routes/verse/ideas/ideas-model.js';

const goals = [
  { id: 'g1', objective: 'Ship the desktop Feed', status: 'active' },
  { id: 'g2', objective: 'Retired aim', status: 'done' },
] as GoalSummary[];
const ideas = rankIdeas([
  { id: 'a', title: 'Drift for g1', source: 'goal-drift', goalId: 'g1', goalName: 'feed', repo: 'org/a' },
  { id: 'b', title: 'Drift for g2', source: 'goal-drift', goalId: 'g2', goalName: 'Old backlog name', repo: 'org/a' },
  { id: 'c', title: 'Plain issue', source: 'issue', repo: 'org/b' },
] as VerseBacklogItem[]);
const byTitle = (title: string) => ideas.find(row => row.title === title)!;

it('labels a goal-drift idea with the live objective, then the backlog name, then the id', () => {
  const g1 = byTitle('Drift for g1');
  expect(goalChipText(ideaGoalId(g1), goals, g1.goal?.name)).toBe('for: Ship the desktop Feed');
  const g2 = byTitle('Drift for g2');
  expect(goalChipText(ideaGoalId(g2), [], g2.goal?.name)).toBe('for: Old backlog name');
  expect(goalChipText('gone', [], 'gone')).toBe('for: goal gone');
  expect(goalChipText(ideaGoalId(byTitle('Plain issue')), goals)).toBeNull();
});

it('offers only open goals in the filter and narrows ideas to the chosen one', () => {
  expect(openGoals(goals).map(goal => goal.id)).toEqual(['g1']);
  expect(filterIdeasByGoal(ideas, 'g1').map(row => row.title)).toEqual(['Drift for g1']);
  expect(filterIdeasByGoal(ideas, 'all')).toHaveLength(3);
});
