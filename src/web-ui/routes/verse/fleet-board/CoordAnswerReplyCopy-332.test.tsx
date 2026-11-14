/**
 * CoordAnswerReplyCopy-332.test.tsx — the "Copy reply" button beside the server
 * recheck line copies the exact `reply` text from GET /api/verse/fleet/recheck.
 * Fake ids only.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { CoordAnswerStrip } from './CoordAnswerStrip.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const REPLY = 'Phantom recheck BLOCKED · fake line one\nBLOCKED on: fake bridge missing';
const RECHECK = { overall: { state: 'BLOCKED', missing: ['fake bridge missing'] }, asOf: new Date().toISOString() };

function stub(body: unknown) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    String(input).startsWith('/api/verse/fleet/recheck') ? json(body) : json({}, 404));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('has no Copy reply button when the response carries no reply', async () => {
  stub({ recheck: RECHECK });
  render(<CoordAnswerStrip visible={true} />);
  await waitFor(() => expect(screen.getByText(/Server recheck · BLOCKED/)).toBeInTheDocument());
  expect(screen.queryByRole('button', { name: /copy phantom recheck reply/i })).toBeNull();
});

it('copies the exact reply text and confirms, requesting ?reply=1', async () => {
  const fetchMock = stub({ recheck: RECHECK, reply: REPLY });
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  render(<CoordAnswerStrip visible={true} />);
  const btn = await screen.findByRole('button', { name: /copy phantom recheck reply/i });
  expect(fetchMock.mock.calls.map((c) => String(c[0]))).toContain('/api/verse/fleet/recheck?reply=1');
  fireEvent.click(btn);
  await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('Copied'));
  expect(writeText).toHaveBeenCalledExactlyOnceWith(REPLY);
});

it('shows Copy failed when the clipboard rejects', async () => {
  stub({ recheck: RECHECK, reply: REPLY });
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn(async () => { throw new Error('denied'); }) } });
  render(<CoordAnswerStrip visible={true} />);
  fireEvent.click(await screen.findByRole('button', { name: /copy phantom recheck reply/i }));
  await waitFor(() => expect(screen.getByRole('button')).toHaveTextContent('Copy failed'));
});
