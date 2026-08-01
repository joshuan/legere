import { beforeEach, describe, expect, it } from 'vitest';
import {
  FixedClock,
  InMemoryEmailVerificationRepository,
  InMemoryPasswordResetRepository,
  InMemoryUserInviteRepository,
} from '../../../../test/helpers/fakes';
import {
  documentFixture,
  InMemoryDocumentRepository,
} from '../../../../test/helpers/processing-fakes';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { InMemoryMetricsCache } from '../../infrastructure/storage/in-memory-metrics-cache';
import { HandleMaintenance } from './handle-maintenance';

const NOW = new Date('2026-03-01T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const LIVE_DOCUMENT = '11111111-1111-4111-8111-111111111111';
const DELETED_DOCUMENT = '22222222-2222-4222-8222-222222222222';
const GONE_DOCUMENT = '33333333-3333-4333-8333-333333333333';

// The hourly housekeeping job (docs/06 §6.8, docs/09 §9.5).
describe('HandleMaintenance', () => {
  let clock: FixedClock;
  let verifications: InMemoryEmailVerificationRepository;
  let invites: InMemoryUserInviteRepository;
  let resets: InMemoryPasswordResetRepository;
  let documents: InMemoryDocumentRepository;
  let files: InMemoryFileStorage;
  let metrics: InMemoryMetricsCache;
  let handler: HandleMaintenance;

  beforeEach(() => {
    clock = new FixedClock(NOW);
    verifications = new InMemoryEmailVerificationRepository(clock);
    invites = new InMemoryUserInviteRepository();
    resets = new InMemoryPasswordResetRepository();
    documents = new InMemoryDocumentRepository();
    files = new InMemoryFileStorage();
    metrics = new InMemoryMetricsCache();
    handler = new HandleMaintenance(
      verifications,
      invites,
      resets,
      documents,
      files,
      metrics,
      clock,
    );
  });

  async function givenCredentials(): Promise<void> {
    for (const [email, expiresAt] of [
      ['stale@legere.local', new Date(NOW.getTime() - HOUR)],
      ['fresh@legere.local', new Date(NOW.getTime() + HOUR)],
    ] as const) {
      await verifications.replace({
        email,
        purpose: 'REGISTER',
        codeHash: 'code',
        expiresAt,
        inviteId: null,
        passwordResetId: null,
      });
    }

    invites.invites.push(
      {
        id: 'invite-stale',
        tokenHash: 'stale',
        role: 'USER',
        emailHint: null,
        createdById: 'admin',
        expiresAt: new Date(NOW.getTime() - HOUR),
        revokedAt: null,
        acceptedAt: null,
        acceptedById: null,
        createdAt: NOW,
      },
      {
        id: 'invite-fresh',
        tokenHash: 'fresh',
        role: 'USER',
        emailHint: null,
        createdById: 'admin',
        expiresAt: new Date(NOW.getTime() + HOUR),
        revokedAt: null,
        acceptedAt: null,
        acceptedById: null,
        createdAt: NOW,
      },
    );

    await resets.create({
      tokenHash: 'stale',
      userId: 'user-1',
      createdById: 'admin',
      expiresAt: new Date(NOW.getTime() - HOUR),
    });
    await resets.create({
      tokenHash: 'fresh',
      userId: 'user-1',
      createdById: 'admin',
      expiresAt: new Date(NOW.getTime() + HOUR),
    });
  }

  it('deletes one-time credentials that have expired and keeps the live ones', async () => {
    await givenCredentials();

    await handler.handle();

    expect([...verifications.records.values()].map((record) => record.email)).toEqual([
      'fresh@legere.local',
    ]);
    expect(invites.invites.map((invite) => invite.id)).toEqual(['invite-fresh']);
    expect(resets.resets.map((reset) => reset.tokenHash)).toEqual(['fresh']);
  });

  it('removes artifacts whose document is gone and keeps everything else', async () => {
    documents.add(documentFixture({ id: LIVE_DOCUMENT }));
    // Soft delete is reversible, so its artifacts stay (docs/09 §9.2).
    documents.add(documentFixture({ id: DELETED_DOCUMENT, deletedAt: NOW }));

    await files.put(`documents/${LIVE_DOCUMENT}/preview.jpg`, Buffer.alloc(10), 'image/jpeg');
    await files.put(`documents/${DELETED_DOCUMENT}/thumb.jpg`, Buffer.alloc(20), 'image/jpeg');
    await files.put(
      `documents/${GONE_DOCUMENT}/canonical.pdf`,
      Buffer.alloc(40),
      'application/pdf',
    );
    await files.put(`documents/${GONE_DOCUMENT}/preview.jpg`, Buffer.alloc(80), 'image/jpeg');
    // Not part of the documents/{id}/ layout: left alone rather than guessed about.
    await files.put('exports/report.csv', Buffer.alloc(5), 'text/csv');

    await handler.handle();

    expect(files.keys()).toEqual([
      `documents/${LIVE_DOCUMENT}/preview.jpg`,
      `documents/${DELETED_DOCUMENT}/thumb.jpg`,
      'exports/report.csv',
    ]);
  });

  it('caches what the bucket holds after the sweep, stamped with the time it was measured', async () => {
    documents.add(documentFixture({ id: LIVE_DOCUMENT }));
    await files.put(`documents/${LIVE_DOCUMENT}/preview.jpg`, Buffer.alloc(1000), 'image/jpeg');
    await files.put(`documents/${GONE_DOCUMENT}/preview.jpg`, Buffer.alloc(500), 'image/jpeg');

    expect(metrics.getStorageUsage()).toBeNull();

    await handler.handle();

    // 500 orphaned bytes were deleted in this very run — counting them would misreport the bucket.
    expect(metrics.getStorageUsage()).toEqual({
      objects: 1,
      bytes: '1000',
      measuredAt: NOW.toISOString(),
    });
  });

  it('reports an empty bucket rather than nothing at all', async () => {
    await handler.handle();

    expect(metrics.getStorageUsage()).toEqual({
      objects: 0,
      bytes: '0',
      measuredAt: NOW.toISOString(),
    });
  });
});
