export function statusColor(status: 'RUNNING' | 'DONE' | 'FAILED'): string {
  if (status === 'RUNNING') return 'processing';
  return status === 'DONE' ? 'green' : 'red';
}
