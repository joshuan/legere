// The one mapping every catalogue answer shares (docs/07 §7.3): `lastDocumentAt` travels as the
// paper's own date — an ISO `yyyy-mm-dd`, never a timestamp, because a signing has no clock
// (docs/03 §3.3.10) — and `null` where no living document carries one.
export function lastDocumentAtIso(date: Date | null): string | null {
  return date === null ? null : date.toISOString().slice(0, 10);
}
