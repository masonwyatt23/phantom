import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const cell = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('|', '&#124;').replaceAll('`', '&#96;').replace(/[\r\n]/g, ' ');

/** Rank reporter spans, retaining failed files and refusing unknown timings. */
export function profileVitest(report, wallSeconds, root = process.cwd()) {
  if (!Number.isFinite(wallSeconds) || wallSeconds <= 0) {
    throw new Error('wallSeconds must be a positive finite number measured around the process');
  }
  if (!Array.isArray(report?.testResults) || report.testResults.length === 0) {
    throw new Error('Expected a nonempty Vitest testResults array');
  }
  const seen = new Set();
  const files = report.testResults.map(result => {
    if (typeof result?.name !== 'string' || !result.name) throw new Error('Missing test file name');
    const file = relative(resolve(root), resolve(root, result.name)).replaceAll('\\', '/');
    if (isAbsolute(file) || file === '..' || file.startsWith('../')) throw new Error('Test file is outside the repository');
    if (seen.has(file)) throw new Error(`Duplicate test file: ${file}`);
    seen.add(file);
    if (!Number.isFinite(result.startTime) || !Number.isFinite(result.endTime) ||
        result.startTime < 0 || result.endTime < result.startTime) {
      throw new Error(`Invalid reporter span for ${file}`);
    }
    const seconds = (result.endTime - result.startTime) / 1000;
    // File spans can overlap; these percentages are not additive wall-time savings.
    if (seconds > wallSeconds) throw new Error(`Reporter span exceeds process wall time for ${file}`);
    return { file, seconds, wallPercent: seconds / wallSeconds * 100,
      status: result.status ?? 'unknown', splitCandidate: seconds > 30 };
  }).sort((a, b) => b.seconds - a.seconds || compare(a.file, b.file));
  const counts = {};
  for (const key of ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests']) {
    if (!Number.isSafeInteger(report[key]) || report[key] < 0) throw new Error(`Invalid ${key}`);
    counts[key] = report[key];
  }
  return { files, wallSeconds, counts, success: report.success === true,
    candidates: files.filter(file => file.splitCandidate) };
}

/** Render the top 25 plus every strict >30-second candidate, even below rank 25. */
export function renderVitestProfile(profile) {
  const { files, candidates, counts, wallSeconds, success } = profile;
  const row = (file, index) => `| ${index + 1} | ${cell(file.file)} | ${file.seconds.toFixed(3)} | ${file.wallPercent.toFixed(2)}% | ${cell(file.status)} | ${file.splitCandidate ? 'RQ-PERF-2 split candidate' : '—'} |`;
  return [
    `Measured process wall time: **${wallSeconds.toFixed(3)} s**. Profiled files: **${files.length}**. Vitest success: **${success}**.`,
    '',
    `Tests: ${counts.numPassedTests} passed, ${counts.numFailedTests} failed, ${counts.numPendingTests} pending, ${counts.numTodoTests} todo; ${counts.numTotalTests} total.`,
    '',
    'File duration is `(endTime - startTime) / 1000` from Vitest JSON: earliest test-case start through latest test-case finish, not the entire module lifecycle. Wall share is file duration divided by measured process wall time. Parallel file spans overlap, so shares do not add up to 100% and do not predict time saved by splitting. Collection, surrounding hooks and process overhead are not separately attributed. Vitest emits a synthetic zero span when no case starts (including skipped-only files and collection failures); zero does not establish that a file was fast.',
    '',
    '## Top 25 slowest files',
    '',
    '| Rank | File | Seconds | Share of wall time | Status | Flag |',
    '| ---: | --- | ---: | ---: | --- | --- |',
    ...files.slice(0, 25).map(row),
    '',
    `## RQ-PERF-2 split candidates (${candidates.length})`,
    '',
    'Threshold: strictly greater than 30 seconds. Failed files remain in the ranking; failure and timeout spans need investigation before performance conclusions.',
    '',
    ...(candidates.length ? candidates.map(file => `- ${cell(file.file)} — ${file.seconds.toFixed(3)} s (${cell(file.status)}).`) : ['None.']),
    '',
  ].join('\n');
}

export function main(args) {
  if (args.length !== 2) throw new Error('Usage: node scripts/vitest-profile.mjs REPORT.json WALL_SECONDS');
  return renderVitestProfile(profileVitest(JSON.parse(readFileSync(args[0], 'utf8')), Number(args[1])));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(main(process.argv.slice(2))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
