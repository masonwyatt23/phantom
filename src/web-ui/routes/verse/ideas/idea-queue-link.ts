import type { IdeaRow } from './ideas-model.js';

export interface QueueLineLike {
  jobId: string;
  title?: string;
  backlogId?: string;
  state: 'queued' | 'running';
}
export interface MergeLike {
  number: number;
  title?: string;
  backlogId?: string;
  jobId?: string | null;
}

type WorkState = { state: 'none' | 'queued' | 'running' | 'merged'; jobId?: string; pr?: number; label: string };
const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

export function ideaWorkState(idea: IdeaRow, lines: readonly QueueLineLike[], merges: readonly MergeLike[]): WorkState {
  // rankIdeas retains the backlog id in its key, followed by its input index.
  const id = idea.key.replace(/#\d+$/, '');
  const title = normalize(idea.title);
  const matches = (item: { backlogId?: string; title?: string }) =>
    item.backlogId ? item.backlogId === id : !!title && typeof item.title === 'string' && normalize(item.title) === title;
  const matched = lines.filter(matches);
  const ids = new Set(matched.map(line => line.jobId));
  const merge = merges.find(item => Number.isSafeInteger(item.number) && item.number > 0 && (matches(item) || (!!item.jobId && ids.has(item.jobId))));
  if (merge) return { state: 'merged', pr: merge.number, label: `Merged in #${merge.number}` };
  const running = lines.find(line => line.state === 'running' && (matches(line) || ids.has(line.jobId)));
  if (running) return { state: 'running', jobId: running.jobId, label: `Running as ${running.jobId}` };
  const queued = matched.find(line => line.state === 'queued');
  if (queued) return { state: 'queued', jobId: queued.jobId, label: `Queued as ${queued.jobId}` };
  return { state: 'none', label: '' };
}
