import { describe, expect, it } from 'vitest';
import { ideaWorkState } from './idea-queue-link.js';
import type { IdeaRow } from './ideas-model.js';

const idea: IdeaRow = { key: 'backlog-1#0', title: 'Fix the queue!', repo: 'org/repo', score: null, scoreText: 'unscored', source: 'issue' };
describe('ideaWorkState', () => {
  it('matches backlog ids before titles', () => {
    expect(ideaWorkState(idea, [{ jobId: 'RQ-ONE', backlogId: 'backlog-1', title: 'different', state: 'queued' }], []).label).toBe('Queued as RQ-ONE');
    expect(ideaWorkState(idea, [{ jobId: 'RQ-ONE', backlogId: 'other', title: idea.title, state: 'queued' }], []).state).toBe('none');
  });
  it('matches normalized titles exactly', () => {
    expect(ideaWorkState(idea, [{ jobId: 'RQ-ONE', title: 'FIX  the queue', state: 'queued' }], []).state).toBe('queued');
    expect(ideaWorkState(idea, [{ jobId: 'RQ-ONE', title: 'Fix the queues', state: 'queued' }], []).state).toBe('none');
  });
  it('prefers merged over running over queued via the job id', () => {
    const lines = [{ jobId: 'RQ-ONE', title: idea.title, state: 'queued' as const }, { jobId: 'RQ-ONE', state: 'running' as const }];
    expect(ideaWorkState(idea, lines, []).label).toBe('Running as RQ-ONE');
    expect(ideaWorkState(idea, lines, [{ number: 42, jobId: 'RQ-ONE' }]).label).toBe('Merged in #42');
  });
  it('returns none for no match', () => {
    expect(ideaWorkState(idea, [], [])).toEqual({ state: 'none', label: '' });
  });
});
