import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUE_NAMES } from '../src/server/application/ports/job-queue';
import { migrateQueue } from './migrate-queue';

const boss = vi.hoisted(() => ({
  on: vi.fn(),
  start: vi.fn(),
  createQueue: vi.fn(),
  updateQueue: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('pg-boss', () => ({ default: vi.fn(() => boss) }));

beforeEach(() => {
  vi.resetAllMocks();
});

describe('queue schema migration lifecycle', () => {
  it('creates and updates each fixed queue before closing the pool', async () => {
    await migrateQueue();
    expect(boss.createQueue).toHaveBeenCalledTimes(QUEUE_NAMES.length);
    expect(boss.updateQueue).toHaveBeenCalledTimes(QUEUE_NAMES.length);
    expect(boss.stop).toHaveBeenCalledExactlyOnceWith({ graceful: true, timeout: 30_000 });
  });

  it.each(['start', 'createQueue', 'updateQueue'] as const)(
    'attempts shutdown and reports a rejected %s',
    async (step) => {
      const failure = new Error('database migration rejected');
      boss[step].mockRejectedValueOnce(failure);
      await expect(migrateQueue()).rejects.toBe(failure);
      expect(boss.stop).toHaveBeenCalledExactlyOnceWith({ graceful: true, timeout: 30_000 });
    },
  );
});
