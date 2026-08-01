import type { ScanSetStatus } from '../../../shared/contracts/enums';

// ScanSet state machine (docs/03 §3.3.16, docs/06 §6.2). The states themselves live in the contract
// enum; what belongs to the domain is which of them still allow a person to change the set.

// A set may be edited — renamed, re-cropped, re-ordered — and merged only while it is DRAFT or
// FAILED. Once a merge is QUEUED the job owns it: moving the pages under a running merge would
// produce a PDF that matches nothing anyone asked for. DONE is final; the result is a document of
// its own from then on.
const EDITABLE: ReadonlySet<ScanSetStatus> = new Set<ScanSetStatus>(['DRAFT', 'FAILED']);

export function canEditItems(scanSet: { status: ScanSetStatus }): boolean {
  return EDITABLE.has(scanSet.status);
}

// The same rule, under the name the merge path reads better with: a set you may still edit is
// exactly a set you may still submit.
export function canMerge(scanSet: { status: ScanSetStatus }): boolean {
  return canEditItems(scanSet);
}
