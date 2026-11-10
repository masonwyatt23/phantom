import { useMemo, useState } from 'react';
import { Button, SkeletonLine } from '../../../components/primitives/index.js';
import { ApiError, apiGet, apiPost } from '../../../data/client.js';
import { getMutationToken, touchMutationHold } from '../../../data/auth-store.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { channelRoundTrip } from '../../../../core/agents/channel-roundtrip.js';
import { formatDuration, formatRelative } from '../autonomy/format.js';
import { annotateAck } from '../fleet-inbox/inbox-ack-model.js';
import type { InboxEntry } from '../fleet-inbox/fleet-inbox-model.js';
import { requestInboxChannel } from '../fleet-inbox/inbox-source-request.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { agentBusPageQuery, agentBusStatusQuery } from '../fleet-bus/agent-bus-queries.js';
import { CopyPill } from '../apps/CopyPill.js';
import { mirrorByChannel, mirrorHint } from './channel-bus-mirror.js';
import { channelPresenceLine, deriveChannelPresence, leaderPassMs, presenceForChannel } from './channel-last-seen.js';
import { ackByChannel, channelSetupHint, KNOWN_CHANNELS, rollupChannels, type ChannelKey } from './fleet-channels-model.js';
import { fleetChannelsQuery } from './fleet-channels-queries.js';
import styles from './fleet-channels.module.css';

// Snapshot inbox rows arrive with `at` as the ET wall clock ("YYYY-MM-DD HH:MM");
// keep the raw string so annotateAck can classify every row instead of dropping it.
function snapshotInboxEntries(inbox: unknown): InboxEntry[] {
  return (Array.isArray(inbox) ? inbox : []).flatMap(value => {
    const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    return typeof row.at === 'string' && typeof row.source === 'string'
      ? [{ at: row.at, source: row.source, priority: typeof row.priority === 'string' ? row.priority : '—', text: typeof row.text === 'string' ? row.text : '' }]
      : [];
  });
}

/** Pane rows that name a leader-network owner channel; the rest can never carry a test send. */
const TESTABLE: Partial<Record<ChannelKey, string>> = { telegram: 'telegram', desktop: 'desktop', email: 'email', imessage: 'imessage' };

const CHANNEL_TEST_PATH = '/api/verse/fleet/runs/channel-test';

/** One owner channel's round-trip entry as the console route reports it. */
interface ChannelTestChannel {
  sentAtMs: number | null;
  correlationId: string | null;
  inbound: number[];
  sendable: { enabled: boolean; reason: string };
}
type ChannelTestMap = Partial<Record<string, ChannelTestChannel>>;

function channelTestRow(value: unknown): ChannelTestChannel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const gate = row.sendable && typeof row.sendable === 'object' && !Array.isArray(row.sendable)
    ? row.sendable as Record<string, unknown> : null;
  return {
    sentAtMs: typeof row.sentAtMs === 'number' && Number.isSafeInteger(row.sentAtMs) ? row.sentAtMs : null,
    correlationId: typeof row.correlationId === 'string' && row.correlationId ? row.correlationId : null,
    inbound: Array.isArray(row.inbound) ? row.inbound.filter(at => Number.isSafeInteger(at)) : [],
    sendable: gate
      ? { enabled: gate.enabled === true, reason: typeof gate.reason === 'string' && gate.reason ? gate.reason : 'Unavailable.' }
      : { enabled: false, reason: 'Unavailable.' },
  };
}

/** Null when the route is not in this build; the map's rows are whatever the route sent. */
const channelTestQuery: QueryDef<ChannelTestMap | null> = {
  key: 'verse-channel-test',
  fetch: async signal => {
    try {
      const body = await apiGet<Record<string, unknown>>(CHANNEL_TEST_PATH, signal);
      const channels = body && typeof body === 'object' && !Array.isArray(body) ? body.channels : null;
      if (!channels || typeof channels !== 'object' || Array.isArray(channels)) return null;
      const out: ChannelTestMap = {};
      for (const [key, value] of Object.entries(channels)) {
        const row = channelTestRow(value);
        if (row) out[key] = row;
      }
      return out;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};

async function sendChannelTest(channel: string): Promise<void> {
  const token = getMutationToken();
  if (!token) throw new Error('No mutation token held for this session yet.');
  await apiPost(CHANNEL_TEST_PATH, { channel }, token);
  touchMutationHold();
}

export function FleetChannelsPane({ visible, host }: PaneProps) {
  const read = useQuery(fleetChannelsQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(fleetChannelsQuery);
  const channelTests = useQuery(channelTestQuery, { enabled: visible, freshMs: 0 });
  const refetchChannelTests = useRefetch(channelTestQuery);
  usePollWhileVisible(() => { refetch(); refetchChannelTests(); }, 15_000, { enabled: visible });
  const [sending, setSending] = useState<ChannelKey | null>(null);
  const [sendError, setSendError] = useState<{ channel: ChannelKey; message: string } | null>(null);
  const busStatus = useQuery(agentBusStatusQuery, { enabled: visible, freshMs: 0 });
  const after = Math.max(0, (busStatus.data?.retainedCount ?? 0) - 100);
  const busPageQuery = useMemo(() => agentBusPageQuery(after, 100), [after]);
  const busPage = useQuery(busPageQuery, { enabled: visible && busStatus.data?.source === 'available' && busStatus.data.retainedCount !== null, freshMs: 0 });
  const refreshBusStatus = useRefetch(agentBusStatusQuery);
  const refreshBusPage = useRefetch(busPageQuery);
  usePollWhileVisible(() => { refreshBusStatus(); if (busStatus.data?.source === 'available' && busStatus.data.retainedCount !== null) refreshBusPage(); }, 15_000, { enabled: visible });
  const nowMs = Date.now();
  const sendTest = async (key: ChannelKey, channel: string): Promise<void> => {
    setSending(key);
    setSendError(null);
    try {
      await sendChannelTest(channel);
      refetchChannelTests();
    } catch (error) {
      const detail = error instanceof ApiError && error.detail ? error.detail : 'The test could not be sent.';
      setSendError({ channel: key, message: detail });
    } finally {
      setSending(null);
    }
  };
  const data = rollupChannels(read.data, nowMs);

  if (read.data === null || (read.error instanceof ApiError && read.error.status === 404)) return <p className={styles.message}>Live runs not in this build</p>;
  if (read.data === undefined) return <div className={styles.root} role="status">{read.status === 'error' ? 'Live runs are unavailable.' : <><span>Reading live runs…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  if (!data) return <p className={styles.message} role="status">Live runs are unavailable.</p>;
  const heard = KNOWN_CHANNELS.length - data.silent.length;
  const last24hTotal = data.rows.reduce((sum, row) => sum + row.last24h, 0);
  const snapshot = read.data && typeof read.data === 'object' && !Array.isArray(read.data) ? read.data as Record<string, unknown> : null;
  const presence = deriveChannelPresence(snapshot?.inbox, snapshot?.leaders, snapshot?.generatedAt, nowMs, KNOWN_CHANNELS);
  const passMs = leaderPassMs(snapshot?.leaders, snapshot?.generatedAt);
  const busUnavailable = busStatus.status === 'error' || busPage.status === 'error' || busStatus.data === null || busPage.data === null
    || (busStatus.data !== undefined && (busStatus.data.source !== 'available' || busStatus.data.retainedCount === null));
  const busState = busUnavailable ? 'unavailable' : busPage.data ? 'available' : 'loading';
  const mirrors = mirrorByChannel(Array.isArray(snapshot?.inbox) ? snapshot.inbox : [], busPage.data?.messages ?? [], nowMs);
  const ack = ackByChannel(annotateAck(snapshotInboxEntries(snapshot?.inbox), read.data, nowMs));
  return <section className={styles.root} aria-label="Channels overview">
    <p className={styles.header}>{heard} of {KNOWN_CHANNELS.length} channels heard from · {last24hTotal} messages in 24 h</p>
    {data.sourceState !== 'healthy' && <p className={styles.notice} role="status">Inbox data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Live runs could not refresh. Showing the last reading.</p>}
    {busUnavailable && <p className={styles.notice} role="status">{mirrorHint('none', busState)}</p>}
    <ul className={styles.list} aria-label="Channels">{data.rows.map(row => {
      const counts = ack.get(row.key);
      const mirror = mirrors.get(row.key)!;
      const mirrorWarning = mirrorHint(mirror.tone, busState);
      const hint = channelSetupHint(row.key, row);
      const ackLine = !counts || (counts.waiting === 0 && counts.seen === 0) ? null
        : counts.waiting > 0 ? `${counts.waiting} waiting for a leader pass${counts.overdue ? ' · overdue' : ''}`
        : `All ${counts.seen} seen by a leader`;
      const testChannel = TESTABLE[row.key];
      const tests = channelTests.data;
      const showTest = tests !== null && tests !== undefined;
      const testRow = testChannel && tests ? tests[testChannel] : undefined;
      const trip = channelRoundTrip(testRow?.sentAtMs ?? null, testRow?.inbound ?? [], nowMs);
      const sendable = !showTest ? null
        : !testChannel ? { enabled: false, reason: 'No live transport for this channel.' }
        : (testRow?.sendable ?? { enabled: false, reason: 'Channel test is unavailable.' });
      const tripLine = trip.state === 'waiting' ? `Sent ${formatRelative(new Date(trip.sentAt).toISOString(), nowMs)} · waiting for your reply`
        : trip.state === 'ok' ? `Round trip OK · ${formatDuration(trip.latencyMs)}`
        : trip.state === 'silent' ? 'No reply yet' : null;
      return <li className={styles.row} key={row.key}>
      <div className={styles.meta}><strong>{row.label}</strong>{' '}<span>{row.lastAt ? <>last <time dateTime={row.lastAt} title={new Date(row.lastAt).toLocaleString()}>{formatRelative(row.lastAt)}</time></> : 'never'}</span></div>
      <span className={styles.counts}>{row.lastHour} / 1 h · {row.last24h} / 24 h</span>
      <p className={styles.presence} role={busState === 'available' && mirror.tone === 'warn' ? 'status' : undefined}>{busState === 'available' ? mirror.text : busState === 'loading' ? 'Checking bus mirror…' : 'Bus mirror unavailable'}{busState === 'available' && mirrorWarning && <> · {mirrorWarning}</>}</p>
      <p className={styles.presence}>{channelPresenceLine(presenceForChannel(presence, row.key, KNOWN_CHANNELS), passMs)}</p>
      {ackLine !== null && <p className={styles.presence} data-testid="channel-ack">{ackLine}</p>}
      {row.preview !== null && <p className={styles.preview}>{row.preview}</p>}
      {hint !== null && <p className={styles.presence} data-testid="channel-setup-hint">{hint.detail} <CopyPill text={hint.runCommand} label={hint.command} what={hint.copyWhat} /></p>}
      {tripLine !== null && <p className={styles.presence} data-testid="channel-trip">{tripLine}</p>}
      <div className={styles.meta}>
        <Button size="sm" onClick={() => { requestInboxChannel(row.key); host.openPane('fleet-inbox'); }}>Open inbox</Button>
        {sendable !== null && <Button size="sm" busy={sending === row.key} disabled={!sendable.enabled} onClick={() => { if (testChannel) void sendTest(row.key, testChannel); }}>Test round trip</Button>}
      </div>
      {sendable !== null && !sendable.enabled && <p className={styles.presence} data-testid="channel-test-reason">{sendable.reason}</p>}
      {sendError?.channel === row.key && <p className={styles.presence} role="status">{sendError.message}</p>}
    </li>;
    })}</ul>
    <p className={styles.message}>Bus mirror checked against the last 100 envelopes</p>
    {data.silent.length > 0 && <p className={styles.message}>Silent: {data.silent.join(', ')}</p>}
  </section>;
}
