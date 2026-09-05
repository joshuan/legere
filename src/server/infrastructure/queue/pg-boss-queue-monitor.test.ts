import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../persistence/prisma.service';
import { PgBossProvider } from './pg-boss.provider';
import { PgBossQueueMonitor } from './pg-boss-queue-monitor';

describe('PgBossQueueMonitor', () => {
  it('maps grouped waiting and completion liveness while filling queues with no rows', async () => {
    const queryRaw = vi.fn(() =>
      Promise.resolve([
        {
          name: 'document-process',
          queued: 4n,
          active: 2n,
          failed_recent: 1n,
          oldest_queued_at: new Date('2026-09-05T10:00:00.000Z'),
          last_completed_at: new Date('2026-09-05T11:30:00.000Z'),
          completed_last_hour: 7n,
        },
      ]),
    );
    const moduleRef = await Test.createTestingModule({
      providers: [
        PgBossQueueMonitor,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
        { provide: PgBossProvider, useValue: { current: () => null } },
      ],
    }).compile();
    const monitor = moduleRef.get(PgBossQueueMonitor);

    await expect(monitor.depths()).resolves.toEqual([
      {
        name: 'library-scan',
        queued: 0,
        active: 0,
        failedRecent: 0,
        oldestQueuedAt: null,
        lastCompletedAt: null,
        completedLastHour: 0,
      },
      {
        name: 'file-ingest',
        queued: 0,
        active: 0,
        failedRecent: 0,
        oldestQueuedAt: null,
        lastCompletedAt: null,
        completedLastHour: 0,
      },
      {
        name: 'document-process',
        queued: 4,
        active: 2,
        failedRecent: 1,
        oldestQueuedAt: '2026-09-05T10:00:00.000Z',
        lastCompletedAt: '2026-09-05T11:30:00.000Z',
        completedLastHour: 7,
      },
      {
        name: 'maintenance',
        queued: 0,
        active: 0,
        failedRecent: 0,
        oldestQueuedAt: null,
        lastCompletedAt: null,
        completedLastHour: 0,
      },
    ]);
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('reads failed work without starting pg-boss or mutating its journal', async () => {
    const payload = {
      documentId: '11111111-1111-4111-8111-111111111111',
      steps: ['preview'],
    };
    const queryRaw = vi.fn(() => Promise.resolve([{ name: 'document-process', data: payload }]));
    const start = vi.fn(() => Promise.reject(new Error('monitor must not send directly')));
    const moduleRef = await Test.createTestingModule({
      providers: [
        PgBossQueueMonitor,
        { provide: PrismaService, useValue: { $queryRaw: queryRaw } },
        { provide: PgBossProvider, useValue: { start } },
      ],
    }).compile();
    const monitor = moduleRef.get(PgBossQueueMonitor);

    await expect(monitor.failedJob('22222222-2222-4222-8222-222222222222')).resolves.toEqual({
      queue: 'document-process',
      payload,
    });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });
});
