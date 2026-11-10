/**
 * routes/verse/ideas/IdeasPane.tsx: what the fleet will pick next. A
 * view of the ranked backlog (`GET /api/backlog`, via the same query the
 * Autonomy panel uses), grouped by repo, each row saying where it came from.
 * Each row can be sent to the Leader as "Do next" / "Not now" (IdeaSteer),
 * or handed to Dot (Ashlr.) over the agent bus with "Send to Dot", after which
 * the row shows the handoff state read back from the bus (idea-dot-handoff.ts).
 * Backlog text is untrusted, so it renders as plain text only.
 */
import { Fragment, useId, useMemo, useRef, useState } from 'react';
import { openDockPane } from '../dock/dock-store.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { goalsQuery, type GoalSummary, type QueryDef } from '../../../data/queries.js';
import { narrowAgentBusPage, type AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { COMMS_STATUS_PATH } from '../fleet-inbox/comms-status-model.js';
import { openGoals } from '../goals-pane/goals-pane-model.js';
import { filterIdeasByGoal, goalChipText, ideaGoalId } from './idea-goal-link.js';
import { Card, CardNote } from '../command/Surface.js';
import { verseBacklogQuery } from '../autonomy/control-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { groupByRepo, ideasHeadline, rankIdeas, sourceCounts, type IdeaRow, type RepoGroup } from './ideas-model.js';
import {
  buildDotHandoffEnvelope, DOT_AGENT_ID, dotActionView, dotRouteFromCommsStatus, ideaHandoffState, isIdeaHandoffReceipt,
  type DotHandoffEnvelope, type DotRoute, type LocalDotSend,
} from './idea-dot-handoff.js';
import { IdeaDraftChip, postIdeasDraft, type IdeaDraftState } from './IdeaDraftChip.js';
import { IdeaSteer } from './IdeaSteer.js';
import styles from './ideas.module.css';

export const IDEAS_POLL_MS = 30_000;
const PER_REPO = 5;
const DRAFT_MAX = 8;
const BUS_PAGE = 100;
// The bus retains at most 1024 messages, so 11 pages always reach the end.
const BUS_MAX_PAGES = 11;

// Same key and endpoint as the Dot resource row and the Comms card, so all three share one cache entry.
const commsStatusQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-status', fetch: s => apiGet(COMMS_STATUS_PATH, s) };

/** The live bus (the existing handoff reader), kept down to idea handoffs and the replies to them. */
export const ideaHandoffsQuery: QueryDef<AgentBusReceipt[]> = {
  key: 'verse-ideas-dot-handoffs',
  fetch: async signal => {
    const rows: AgentBusReceipt[] = [];
    let after = 0;
    for (let i = 0; i < BUS_MAX_PAGES; i++) {
      const page = narrowAgentBusPage(await apiGet<unknown>(`/api/verse/agent-bus?after=${after}&limit=${BUS_PAGE}`, signal));
      if (!page) throw new Error('The agent bus returned a page this pane cannot read.');
      rows.push(...page.messages.filter(isIdeaHandoffReceipt));
      // Expired rows still advance the cursor, so an empty page is not the end.
      if (page.nextCursor <= after) break;
      after = page.nextCursor;
    }
    return rows;
  },
};

// What this session saw when it posted, per idea id; the bus reader stays the authority.
const localSends = new Map<string, LocalDotSend>();

/** Post one handoff through the existing bus POST. Never posts to anyone but Dot. */
export async function postDotHandoff(envelope: DotHandoffEnvelope, now: number): Promise<LocalDotSend> {
  const failed = (reason: string): LocalDotSend => ({ status: 'failed', at: now, reason });
  if (envelope.to !== DOT_AGENT_ID) return failed('refused: not addressed to Dot');
  const token = getMutationToken();
  if (!token) return failed('unlock actions with the mutation token first');
  try {
    const result = await apiPost<{ status?: unknown }>('/api/verse/agent-bus', envelope, token);
    if (result?.status !== 'posted' && result?.status !== 'duplicate') return failed('the bus did not accept it');
    touchMutationHold();
    return { status: result.status, at: now, ttl: envelope.ttl };
  } catch (error) {
    if (error instanceof ApiError) {
      switch (error.status) {
        case 400: return failed('the bus rejected the envelope');
        case 401: case 403: return failed('unlock actions with the mutation token first');
        case 404: return failed('this hub was started without --allow-dispatch');
        case 409: return failed('a different message already uses this id');
        case 507: return failed('the bus is full');
      }
    }
    return failed('the bus is unavailable');
  }
}

export function IdeasPane({ visible = true }: { visible?: boolean }) {
  const backlog = useQuery(verseBacklogQuery, { enabled: visible, freshMs: IDEAS_POLL_MS });
  const goals = useQuery(goalsQuery, { enabled: visible });
  const [goalFilter, setGoalFilter] = useState('all');
  const refetch = useRefetch(verseBacklogQuery);
  usePollWhileVisible(() => { refetch(); }, IDEAS_POLL_MS, { enabled: visible });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, { state: IdeaDraftState; ids: readonly string[] }>>(new Map());
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const comms = useQuery(commsStatusQuery, { enabled: visible, freshMs: IDEAS_POLL_MS });
  const handoffs = useQuery(ideaHandoffsQuery, { enabled: visible, freshMs: IDEAS_POLL_MS });
  const refetchHandoffs = useRefetch(ideaHandoffsQuery);
  usePollWhileVisible(() => { refetchHandoffs(); }, IDEAS_POLL_MS, { enabled: visible });
  const dotNoteId = useId();
  const route = useMemo(() => dotRouteFromCommsStatus(comms.error ? undefined : comms.data, comms.data === undefined && !comms.error),
    [comms.data, comms.error]);
  const dotNote = dotActionView(route, null, false).note;
  const dot: DotContext = { route, handoffs: handoffs.data ?? [], noteId: route.status === 'configured' ? undefined : dotNoteId, onSent: refetchHandoffs };

  const allRows = useMemo(() => rankIdeas(backlog.data?.items ?? []), [backlog.data]);
  const rows = useMemo(() => filterIdeasByGoal(allRows, goalFilter), [allRows, goalFilter]);
  const full = useMemo(() => groupByRepo(rows, Number.MAX_SAFE_INTEGER), [rows]);
  const groups = useMemo(() => groupByRepo(rows, PER_REPO), [rows]);
  const { counts, nudge } = useMemo(() => sourceCounts(rows), [rows]);

  const toggle = (repo: string) => setOpen(prev => {
    const next = new Set(prev);
    if (!next.delete(repo)) next.add(repo);
    return next;
  });

  const togglePick = (id: string) => setPicked(prev => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const draft = async (ids: readonly string[], confirm = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    let state: IdeaDraftState;
    try { state = await postIdeasDraft(ids, confirm); }
    catch (err) { state = { error: err instanceof Error ? err.message : 'Could not draft this idea. Try again.' }; }
    setDrafts(prev => new Map([...prev, ...ids.map((id): [string, { state: IdeaDraftState; ids: readonly string[] }] => [id, { state, ids }])]));
    inFlight.current = false;
    setBusy(false);
  };

  let body;
  if (backlog.data === undefined && backlog.status === 'error') {
    body = <CardNote tone="danger">{backlog.error?.message ?? 'Could not read the backlog.'}</CardNote>;
  } else if (backlog.data === undefined) {
    body = <CardNote>Loading ideas…</CardNote>;
  } else if (backlog.data.absent) {
    body = <CardNote>No backlog has been built yet. Run <code>ashlr backlog</code> or one tick from Controls.</CardNote>;
  } else if (allRows.length === 0) {
    body = <CardNote>The backlog is empty, so a tick idles. Enroll another repository in Scope, or add a goal, to give it work.</CardNote>;
  } else if (rows.length === 0) {
    body = <CardNote>No ideas for this goal.</CardNote>;
  } else {
    body = <>
      <p className={styles.headline}>{ideasHeadline(rows)}</p>
      {nudge ? <CardNote tone="unknown">{nudge}</CardNote> : null}
      <p className={styles.sources}>
        {counts.map(({ source, count }, i) => <Fragment key={source}>{i ? ' · ' : ''}{source} {count}</Fragment>)}
      </p>
      {route.status !== 'configured' && dotNote ? <p className={styles.meta} id={dotNoteId}>{dotNote}</p> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.toggle} disabled={busy || picked.size < 2 || picked.size > DRAFT_MAX}
          onClick={() => { void draft([...picked]); }}>Draft together</button>
        <span className={styles.meta}>{picked.size === 0 ? `Tick 2 to ${DRAFT_MAX} ideas to draft them as one job.` : `${picked.size} selected`}</span>
      </div>
      <div className={styles.groups}>
        {groups.map((group, i) => <RepoCard key={group.repo} group={group} all={full[i]!} goals={goals.data ?? []} expanded={open.has(group.repo)} onToggle={() => toggle(group.repo)} picked={picked} drafts={drafts} busy={busy} onPick={togglePick} onDraft={draft} dot={dot} />)}
      </div>
    </>;
  }

  return <div className={styles.root} aria-label="Ideas">
    <label>Goal: <select value={goalFilter} onChange={event => setGoalFilter(event.target.value)}>
      <option value="all">All</option>
      {openGoals(goals.data ?? []).map(goal => <option key={goal.id} value={goal.id}>{goal.objective}</option>)}
    </select></label>
    {body}
  </div>;
}

interface DotContext {
  route: DotRoute;
  handoffs: readonly AgentBusReceipt[];
  /** Id of the pane-level "Dot route not configured" note, when the action is off. */
  noteId: string | undefined;
  onSent: () => void;
}

function RepoCard({ group, all, goals, expanded, onToggle, picked, drafts, busy, onPick, onDraft, dot }: {
  group: RepoGroup; all: RepoGroup; goals: readonly GoalSummary[]; expanded: boolean; onToggle: () => void;
  picked: ReadonlySet<string>; drafts: ReadonlyMap<string, { state: IdeaDraftState; ids: readonly string[] }>;
  busy: boolean; onPick: (id: string) => void; onDraft: (ids: readonly string[], confirm?: boolean) => Promise<void>;
  dot: DotContext;
}) {
  const listId = useId();
  const shown = expanded ? all.rows : group.rows;
  return (
    <Card title={group.repo} caption={`${all.rows.length} candidate${all.rows.length === 1 ? '' : 's'}`}>
      <ol className={styles.list} id={listId}>
        {shown.map(row => <li key={row.key} className={styles.row}>
          <label className={styles.pick}><input type="checkbox" disabled={busy || row.id === null} checked={row.id !== null && picked.has(row.id)}
            onChange={() => { if (row.id !== null) onPick(row.id); }} aria-label={`Select ${row.title}`} />
            <span className={styles.title}>{row.title}</span></label>
          <span className={styles.meta}>{row.scoreText} · {row.source}</span>
          {ideaGoalId(row) ? <button type="button" className={styles.toggle} onClick={() => openDockPane('goals')}>{goalChipText(ideaGoalId(row), goals)}</button> : null}
          <IdeaSteer idea={row} repo={group.repo} />
          <span className={styles.actions}>
            <button type="button" className={styles.toggle} disabled={busy || row.id === null}
              onClick={() => { if (row.id !== null) void onDraft([row.id]); }}>Draft job</button>
            {row.id !== null && drafts.has(row.id) ? <IdeaDraftChip state={drafts.get(row.id)!.state} disabled={busy}
              onConfirm={() => { void onDraft(drafts.get(row.id!)!.ids, true); }} /> : null}
            <IdeaDotHandoff idea={row} dot={dot} />
          </span>
        </li>)}
      </ol>
      {group.more > 0 ? <button type="button" className={styles.toggle} aria-expanded={expanded} aria-controls={listId} onClick={onToggle}>
        {expanded ? 'Show fewer' : `Show ${group.more} more`}
      </button> : null}
    </Card>
  );
}

/** "Send to Dot" plus the handoff state the bus reports for this idea. */
function IdeaDotHandoff({ idea, dot }: { idea: IdeaRow; dot: DotContext }) {
  const [sending, setSending] = useState(false);
  const [local, setLocal] = useState(idea.id === null ? undefined : localSends.get(idea.id));
  const action = dotActionView(dot.route, idea.id, sending);
  const state = idea.id === null ? null : ideaHandoffState(dot.handoffs, idea.id, { now: Date.now(), ...(local ? { local } : {}) });

  const send = async () => {
    if (idea.id === null || action.disabled) return;
    const ideaId = idea.id;
    setSending(true);
    const built = buildDotHandoffEnvelope({ id: ideaId, title: idea.title, repo: idea.repo,
      ...(idea.rationale ? { rationale: idea.rationale } : {}), ...(idea.goal ? { goal: idea.goal } : {}) });
    const outcome = built.ok ? await postDotHandoff(built.envelope, Date.now())
      : { status: 'failed' as const, at: Date.now(), reason: built.problem };
    localSends.set(ideaId, outcome);
    setLocal(outcome);
    setSending(false);
    if (outcome.status !== 'failed') dot.onSent();
  };

  return <>
    <button type="button" className={styles.toggle} disabled={action.disabled} aria-describedby={dot.noteId}
      onClick={() => { void send(); }}>Send to Dot</button>
    {action.note && dot.route.status === 'configured' ? <span className={styles.meta}>{action.note}</span> : null}
    {state && state.state !== 'none' ? <span className={state.state === 'failed' ? styles.chipBad : styles.meta}
      data-testid="idea-dot-state" data-state={state.state} title={`Handoff id ${state.handoffId}`}>{state.label}</span> : null}
    {state?.replyId ? <button type="button" className={styles.toggle} onClick={() => openDockPane('library')}>Open reply in Library</button> : null}
  </>;
}
