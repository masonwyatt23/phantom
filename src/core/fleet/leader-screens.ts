import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseInbox } from './mason-inbox.js';

export interface LeaderScreen {
  name: string;
  path: string;
  takenAt: string;
  bytes: number;
  ext: 'png' | 'jpg';
  inboxId: string | null;
  inboxAt: string | null;
  caption: string | null;
}

function inboxTail(file: string): string {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return ''; }
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - 512 * 1024);
    const buffer = Buffer.alloc(size - start);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (!n) break;
      read += n;
    }
    const text = buffer.subarray(0, read).toString('utf8');
    if (!start) return text;
    const newline = text.indexOf('\n');
    return newline < 0 ? '' : text.slice(newline + 1);
  } catch { return ''; } finally { closeSync(fd); }
}

export function listLeaderScreens(opts: { runsDir: string; limit?: number; since?: Date }): {
  v: 1; observedAt: string; state: 'ok' | 'absent'; screens: LeaderScreen[]
} {
  const observedAt = new Date().toISOString();
  const dir = resolve(opts.runsDir, 'leader', 'inbound', 'screens');
  let names: string[];
  try { names = readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, observedAt, state: 'absent', screens: [] };
    throw error;
  }
  const entries = parseInbox(inboxTail(join(resolve(opts.runsDir), 'leader', 'MASON-INBOX.md')), 512 * 1024);
  const limit = Number.isFinite(opts.limit) ? Math.max(0, Math.min(200, Math.floor(opts.limit!))) : 20;
  const screens: LeaderScreen[] = [];
  for (const name of names.sort().reverse()) {
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{8}\.(png|jpg)$/.exec(name);
    if (!match) continue;
    const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.000Z`;
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime()) || date.toISOString() !== iso || (opts.since && date < opts.since)) continue;
    const path = join(dir, name);
    let stat;
    try { stat = lstatSync(path); } catch { continue; }
    if (!stat.isFile()) continue;
    const suffix = ` [image: ${path}]`;
    const entry = entries.find(item => item.text.includes(suffix));
    screens.push({ name, path, takenAt: iso, bytes: stat.size, ext: match[7] as 'png' | 'jpg',
      inboxId: entry?.id ?? null, inboxAt: entry?.at ?? null,
      caption: entry ? entry.text.replace(/ \[image: [^\n]*\]$/, '').trim().slice(0, 200) : null });
    if (screens.length >= limit) break;
  }
  return { v: 1, observedAt, state: 'ok', screens: limit === 0 ? [] : screens };
}
