export function preparingWord(input: { preparing: boolean; tickStartedAt?: string | null; running: number; now: number; reason?: string | null }): { word: string; detail: string | null } {
  if (!input.preparing) return { word: '', detail: null };
  const started = input.tickStartedAt ? Date.parse(input.tickStartedAt) : NaN;
  const minutes = Math.floor((input.now - started) / 60_000);
  if (input.running !== 0 || !Number.isFinite(minutes) || minutes < 3) {
    return { word: 'Preparing work', detail: null };
  }
  return { word: `Stalled preparing · ${minutes}m`, detail: input.reason?.trim() || 'No agent started and no reason was reported.' };
}
