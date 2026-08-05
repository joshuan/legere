import { z } from 'zod';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { EmailVerificationRepository } from '../../domain/repositories/email-verification.repository';
import type { PasswordResetRepository } from '../../domain/repositories/password-reset.repository';
import type { UserInviteRepository } from '../../domain/repositories/user-invite.repository';
import type { Clock } from '../ports/clock';
import type { FileStorage, StoredObjectInfo } from '../ports/file-storage';
import type { JobQueue } from '../ports/job-queue';
import type { MetricsCache } from '../ports/metrics-cache';
import { JobHandler } from './job-handler';

// The cron sends no payload; anything pg-boss stored alongside it is ignored.
export const maintenancePayloadSchema = z.object({}).passthrough();

// Artifacts are keyed `documents/{documentId}/...` (docs/09 §9.2); the id is the only thing in the
// key that ties an object to a row.
const DOCUMENT_KEY = /^documents\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//;

// One `IN (...)` per this many ids, so a bucket with a hundred thousand documents does not build a
// single enormous query.
const EXISTENCE_BATCH = 500;

// How long a document may sit at PENDING before this job assumes nobody is coming for it. Longer
// than `document-process` takes to expire, so a slow document is never enqueued twice.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;

// A bound on one sweep: an upgrade that resets every document must not put the whole archive into
// the queue in one hour, and the next sweep picks up where this one stopped.
const STALE_BATCH = 200;

// `maintenance`, hourly (docs/06 §6.8). Housekeeping only: nothing here is on a request path, and
// nothing it does is visible to a user except by things not piling up.
export class HandleMaintenance extends JobHandler {
  constructor(
    private readonly verifications: EmailVerificationRepository,
    private readonly invites: UserInviteRepository,
    private readonly resets: PasswordResetRepository,
    private readonly documents: DocumentRepository,
    private readonly files: FileStorage,
    private readonly metrics: MetricsCache,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
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
    const stalled = await this.documents.listStalePendingIds(
      new Date(now.getTime() - STALE_AFTER_MS),
      STALE_BATCH,
    );
    for (const documentId of stalled) {
      await this.queue.enqueue('document-process', { documentId }, { singletonKey: documentId });
    }

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

  // Objects whose document does not exist *at all* — the only thing MVP ever hard-deletes from the
  // bucket (docs/09 §9.2), and only reachable through a half-written ingest. A soft-deleted document
  // keeps its artifacts, so it counts as existing here; anything outside the documents/ layout is
  // left alone rather than guessed about.
  private async findOrphans(objects: StoredObjectInfo[]): Promise<ReadonlySet<string>> {
    const byDocument = new Map<string, string[]>();
    for (const object of objects) {
      const documentId = DOCUMENT_KEY.exec(object.key)?.[1];
      if (documentId === undefined) continue;
      const keys = byDocument.get(documentId);
      if (keys === undefined) byDocument.set(documentId, [object.key]);
      else keys.push(object.key);
    }

    const ids = [...byDocument.keys()];
    const existing = new Set<string>();
    for (let from = 0; from < ids.length; from += EXISTENCE_BATCH) {
      const found = await this.documents.filterExistingIds(ids.slice(from, from + EXISTENCE_BATCH));
      for (const id of found) existing.add(id);
    }

    const orphans = new Set<string>();
    for (const [documentId, keys] of byDocument) {
      if (existing.has(documentId)) continue;
      for (const key of keys) orphans.add(key);
    }
    return orphans;
  }
}
