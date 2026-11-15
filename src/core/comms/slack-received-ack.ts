/** Pure receipt acknowledgement; an absent thread never permits a broadcast. */
export function planReceivedAck(input: {
  receiptId: string; duplicate: boolean; threadKey: string; asOf: string;
}): { text: string; dedupeKey: string } | null {
  if (input.duplicate || !input.threadKey.trim()) return null;
  return {
    text: `RECEIVED: receipt ${input.receiptId} as of ${input.asOf}. Not yet assigned.`,
    dedupeKey: `received:${input.receiptId}`,
  };
}
