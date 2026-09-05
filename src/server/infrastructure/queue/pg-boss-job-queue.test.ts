import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';
import { JobQueue } from '../../application/ports/job-queue';
import { PgBossJobQueue } from './pg-boss-job-queue';
import { PgBossProvider } from './pg-boss.provider';

describe('PgBossJobQueue', () => {
  it('applies retry, backoff, expiry and the document work key on every enqueue', async () => {
    const send = vi.fn(() => Promise.resolve('job-id'));
    const start = vi.fn(() => Promise.resolve({ send }));
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: PgBossProvider, useValue: { start } },
        { provide: JobQueue, useClass: PgBossJobQueue },
      ],
    }).compile();
    const queue = moduleRef.get(JobQueue);
    const payload = {
      documentId: '11111111-1111-4111-8111-111111111111',
      steps: ['preview', 'canonical', 'preview'],
    };

    await queue.enqueue('document-process', payload);

    expect(send).toHaveBeenCalledWith('document-process', payload, {
      retryLimit: 5,
      retryBackoff: true,
      expireInSeconds: 3 * 60 * 60,
      singletonKey: '11111111-1111-4111-8111-111111111111#canonical+preview',
    });
  });
});
