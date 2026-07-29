import { Injectable } from '@nestjs/common';
import { JobQueue, type EnqueueOptions, type QueueName } from '../../application/ports/job-queue';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import { isPrismaTx } from '../persistence/prisma-client';
import { EXPIRE_IN_HOURS, PgBossProvider, RETRY_LIMIT } from './pg-boss.provider';

@Injectable()
export class PgBossJobQueue extends JobQueue {
  constructor(private readonly provider: PgBossProvider) {
    super();
  }

  async enqueue(
    name: QueueName,
    payload: object,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    const boss = await this.provider.start();
    return boss.send(name, payload, this.sendOptions(options));
  }

  // Runs the INSERT on the transaction's own connection, so the job and the entity write commit
  // together — or not at all (docs/06 §6.3.4). pg-boss takes a `db` with executeSql; Prisma's
  // $queryRawUnsafe on the transaction client is exactly that connection.
  async enqueueAfterTx(
    tx: TransactionHandle,
    name: QueueName,
    payload: object,
    options: EnqueueOptions = {},
  ): Promise<string | null> {
    if (!isPrismaTx(tx)) throw new Error('enqueueAfterTx requires a Prisma transaction handle');
    const boss = await this.provider.start();

    return boss.send(name, payload, {
      ...this.sendOptions(options),
      db: {
        executeSql: async (text: string, values: unknown[]) => {
          const rows = await tx.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values);
          return { rows };
        },
      },
    });
  }

  async scheduleCron(
    name: QueueName,
    cron: string,
    payload: object = {},
    key?: string,
  ): Promise<void> {
    const boss = await this.provider.start();
    // Re-scheduling the same name replaces the previous spec, so a changed interval takes effect
    // without leaving a stale schedule behind (docs/06 §6.8).
    await boss.schedule(name, cron, payload, key === undefined ? {} : { singletonKey: key });
  }

  async unscheduleCron(name: QueueName): Promise<void> {
    const boss = await this.provider.start();
    await boss.unschedule(name).catch(() => undefined);
  }

  private sendOptions(options: EnqueueOptions) {
    return {
      retryLimit: RETRY_LIMIT,
      retryBackoff: true,
      expireInHours: EXPIRE_IN_HOURS,
      ...(options.singletonKey === undefined ? {} : { singletonKey: options.singletonKey }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    };
  }
}
