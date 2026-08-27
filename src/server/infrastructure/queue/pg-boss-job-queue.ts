import { Injectable } from '@nestjs/common';
import { JobQueue, type EnqueueOptions, type QueueName } from '../../application/ports/job-queue';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import { isPrismaTx } from '../persistence/prisma-client';
import { EXPIRE_IN_SECONDS, PgBossProvider, RETRY_LIMIT } from './pg-boss.provider';

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
    return boss.send(name, payload, this.sendOptions(name, payload, options));
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
      ...this.sendOptions(name, payload, options),
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

  // The expiry travels on the job itself, not only on the queue: pg-boss copies it into the row at
  // insert time, so a job sent with the old value would keep it even after the queue was updated.
  private sendOptions(name: QueueName, payload: object, options: EnqueueOptions) {
    const singletonKey = options.singletonKey ?? derivedKeyOf(name, payload);
    return {
      retryLimit: RETRY_LIMIT,
      retryBackoff: true,
      expireInSeconds: EXPIRE_IN_SECONDS[name],
      ...(singletonKey === undefined ? {} : { singletonKey }),
      ...(options.priority === undefined ? {} : { priority: options.priority }),
    };
  }
}

// 🔒 What one piece of `document-process` work is, decided here rather than at the eight call sites
// that ask for one (docs/05 §5.4, docs/06 §6.8). Three of them passed a key and five did not, and
// the five that did not include every composition edit — which is exactly the flood SEC-50 is about,
// and exactly the kind of omission a per-call-site rule keeps producing. Everything the queue
// receives passes through here, so a ninth call site cannot forget.
//
// The key is the document **and what is being asked about it**, not the document alone. Under the
// `short` policy a second job with a key already queued is silently not created — so if the key were
// the document alone, a rebuild asked for by a crop would be swallowed by a pending one-step job
// that will never rebuild anything, and the crop would simply never appear. Two requests for the
// same steps of the same document *are* the same piece of work and collapse into one; two requests
// for different steps are not, and both are kept.
function derivedKeyOf(name: QueueName, payload: object): string | undefined {
  if (name !== 'document-process') return undefined;

  const asked: Record<string, unknown> = { ...payload };
  const documentId = asked.documentId;
  if (typeof documentId !== 'string') return undefined;

  const raw: unknown[] = Array.isArray(asked.steps) ? asked.steps : [];
  const steps = raw.filter((step): step is string => typeof step === 'string').sort();
  // Sorted and joined, so the same set asked for in two orders is one key; `#full` because a person
  // asking for a long document to be analysed whole is asking for different work from the run that
  // would skip it (docs/05 §5.5 step 4).
  const full = asked.analyseInFull === true ? '#full' : '';
  return steps.length === 0 ? `${documentId}${full}` : `${documentId}${full}#${steps.join('+')}`;
}
