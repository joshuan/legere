import { z } from 'zod';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { FileRepository } from '../../domain/repositories/file.repository';
import type { ReceiptRepository } from '../../domain/repositories/receipt.repository';
import type { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import type { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import type { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import type { Clock } from '../ports/clock';
import type { FileStorage, StoredObjectInfo } from '../ports/file-storage';
import type { JobQueue } from '../ports/job-queue';
import type { MetricsCache } from '../ports/metrics-cache';
import type { UnitOfWork } from '../ports/unit-of-work';
import type { QueueSettings } from '../queue/queue-settings';
import { purge } from '../trash/manage-trash';
import { JobHandler } from './job-handler';

// The cron sends no payload; anything pg-boss stored alongside it is ignored.
export const maintenancePayloadSchema = z.object({}).passthrough();

// Product artifacts are keyed by their profile id, and a managed file's own bytes by its file id
// (docs/09 §9.2, docs/15 §15.5). The id is the only thing in a key that ties an object to a row.
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const DOCUMENT_KEY = new RegExp(`^documents/(${UUID})/`);
const RECEIPT_KEY = new RegExp(`^receipts/(${UUID})/`);
const FILE_KEY = new RegExp(`^files/(${UUID})/`);

// One `IN (...)` per this many ids, so a bucket with a hundred thousand documents does not build a
// single enormous query.
const EXISTENCE_BATCH = 500;

// Stale statuses without any live queue delivery are recoverable after this grace period.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// A bound on one sweep: an upgrade that resets every document must not put the whole archive into
// the queue in one hour, and the next sweep picks up where this one stopped.
const STALE_BATCH = 200;

// The same bound, for the same reason, on the files whose time in the trash is up.
const PURGE_BATCH = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

// `maintenance`, hourly (docs/06 §6.8). Housekeeping only: nothing here is on a request path, and
// nothing it does is visible to a user except by things not piling up.
export class HandleMaintenance extends JobHandler {
  constructor(
    private readonly verifications: EmailVerificationRepository,
    private readonly invites: UserInviteRepository,
    private readonly resets: PasswordResetRepository,
    private readonly documents: DocumentRepository,
    private readonly receipts: Pick<ReceiptRepository, 'filterExistingIds'>,
    private readonly fileRows: FileRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly files: FileStorage,
    private readonly metrics: MetricsCache,
    private readonly queue: JobQueue,
    private readonly queueSettings: QueueSettings,
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
    private readonly trashRetentionDays: number,
  ) {
    super();
  }

  async handle(): Promise<void> {
    const now = this.clock.now();

    // Expired one-time credentials are worthless and are also the most sensitive rows in the
    // database (docs/08 §8.1.3): they go as soon as they cannot be used.
    await this.verifications.deleteExpired(now);
    await this.invites.deleteExpired(now);
    await this.resets.deleteExpired(now);

    // Documents nobody is coming for: a job lost to a crash, or a migration that reset every step
    // and had no way to enqueue anything (docs/05 §5.4). The handler is idempotent, so the cost of
    // being wrong here is one repeated run and never a broken document.
    //
    // 🔒 A step this instance is holding is not one of them (docs/05 §5.4d): it is unstarted on
    // purpose, and a document waiting at a pause would otherwise be enqueued hourly, for ever, to be
    // held again — an hourly job that does nothing but keep the queue busy.
    const held = [...(await this.queueSettings.heldSteps())];
    await this.unitOfWork.run(
      async (tx) => {
        const stalled = await this.documents.listStaleUnstartedIds(
          new Date(now.getTime() - STALE_AFTER_MS),
          STALE_BATCH,
          held,
          tx,
        );
        for (const { id, steps } of stalled) {
          // Resume only unfinished stages. Locks, job inserts and status changes commit together.
          await this.queue.enqueueAfterTx(tx, 'document-process', {
            documentId: id,
            steps,
            resume: true,
          });
          await this.documents.markUnstartedQueued(id, steps, tx);
        }
      },
      { timeoutMs: 30_000 },
    );

    // 🔒 The one destruction in Legere that happens on a clock (docs/05 §5.7a): files of ours that
    // have sat in the trash past the retention window. A LIBRARY file is never in this answer — its
    // bytes are on a read-only volume, so no window closes on them and it waits for a person.
    // Bounded per sweep, so a trash somebody filled in one afternoon drains over a few hours rather
    // than in one indigestible push.
    const expired = await this.fileRows.listPurgeable(
      new Date(now.getTime() - this.trashRetentionDays * DAY_MS),
      PURGE_BATCH,
    );
    await purge(expired, this.fileRows, this.fileRefs, this.files, this.unitOfWork);

    // One listing of the bucket answers both remaining questions (docs/09 §9.5).
    const objects = await this.files.list('');
    const orphans = await this.findOrphans(objects);
    for (const key of orphans) await this.files.delete(key);

    const kept = objects.filter((object) => !orphans.has(object.key));
    this.metrics.setStorageUsage({
      objects: kept.length,
      // A string: a large bucket holds more bytes than a JS number counts exactly.
      bytes: kept.reduce((total, object) => total + BigInt(object.size), 0n).toString(),
      measuredAt: this.clock.now().toISOString(),
    });
  }

  // Objects whose profile/file owner does not exist *at all* (docs/09 §9.2, docs/15 §15.5). Two
  // ways to arrive here: a half-written ingest, and a hard delete whose bucket calls did not all
  // land. Soft-deleted products keep their profiles and artifacts; unknown layouts stay untouched.
  private async findOrphans(objects: StoredObjectInfo[]): Promise<ReadonlySet<string>> {
    const byDocument = group(objects, DOCUMENT_KEY);
    const byReceipt = group(objects, RECEIPT_KEY);
    const byFile = group(objects, FILE_KEY);

    const liveDocuments = await this.existing([...byDocument.keys()], (ids) =>
      this.documents.filterExistingIds(ids),
    );
    const liveReceipts = await this.existing([...byReceipt.keys()], (ids) =>
      this.receipts.filterExistingIds(ids),
    );
    const liveFiles = await this.existing([...byFile.keys()], (ids) =>
      this.fileRows.filterExistingIds(ids),
    );

    const orphans = new Set<string>();
    addMissing(orphans, byDocument, liveDocuments);
    addMissing(orphans, byReceipt, liveReceipts);
    addMissing(orphans, byFile, liveFiles);
    return orphans;
  }

  // The same batched existence question, whichever table is being asked.
  private async existing(
    ids: string[],
    ask: (batch: string[]) => Promise<string[]>,
  ): Promise<ReadonlySet<string>> {
    const found = new Set<string>();
    for (let from = 0; from < ids.length; from += EXISTENCE_BATCH) {
      for (const id of await ask(ids.slice(from, from + EXISTENCE_BATCH))) found.add(id);
    }
    return found;
  }
}

// The objects of one owner, keyed by the id in their key; objects the pattern does not match are not
// this sweep's business.
function group(objects: StoredObjectInfo[], pattern: RegExp): Map<string, string[]> {
  const byOwner = new Map<string, string[]>();
  for (const object of objects) {
    const id = pattern.exec(object.key)?.[1];
    if (id === undefined) continue;
    const keys = byOwner.get(id);
    if (keys === undefined) byOwner.set(id, [object.key]);
    else keys.push(object.key);
  }
  return byOwner;
}

function addMissing(
  target: Set<string>,
  byOwner: ReadonlyMap<string, string[]>,
  liveOwners: ReadonlySet<string>,
): void {
  for (const [id, keys] of byOwner) {
    if (liveOwners.has(id)) continue;
    for (const key of keys) target.add(key);
  }
}
