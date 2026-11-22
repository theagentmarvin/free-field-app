/**
 * FreeField UI status labels, replicated here so the writer has no UI dependency.
 * Mirrors STATUS_LABELS in @ff/tasks-react (pinned by __tests__/bcf/labels.test.ts).
 */
export const BCF_STATUS_LABELS: Readonly<Record<number, string>> = {
  10: 'Inbox',
  20: 'Ongoing',
  30: 'Rejected',
  40: 'Awaiting approval',
  60: 'Follow-up',
  65: 'Approved',
  80: 'Discontinued',
};

export function statusLabel(status: number): string {
  return BCF_STATUS_LABELS[status] ?? `Status ${status}`;
}
