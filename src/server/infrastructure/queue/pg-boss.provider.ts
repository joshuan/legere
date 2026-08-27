import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import PgBoss from 'pg-boss';
import { QUEUE_NAMES, type QueueName } from '../../application/ports/job-queue';
import { AppConfig } from '../config/app-config';

// Retry policy shared by every queue (docs/06 §6.8).
export const RETRY_LIMIT = 5;

// How long a job may stay `active` before pg-boss decides its worker is gone and hands it to
// someone else. This is the recovery time after a crash, a deploy or a `nodemon` restart — not a
// timeout for the work itself — and it has to be sized per queue, because with the `stately` policy
// an abandoned job keeps its singleton slot: a scan whose worker died blocks every later scan of
// that library for exactly this long, and the ScanRun it left behind reads RUNNING all the while.
// One shared two-hour value made that two hours.
//
// Generous multiples of what each handler actually takes, since every handler is idempotent
// (docs/05 §5.4) and a premature reclaim costs a repeat, not corruption.
export const EXPIRE_IN_SECONDS: Readonly<Record<QueueName, number>> = {
  // Walks the tree and enqueues per-file work; the hashing happens elsewhere.
  'library-scan': 15 * 60,
  // Reads and hashes one file.
  'file-ingest': 10 * 60,
  // 🔒 The slow one, and the only one whose expiry has to be argued rather than picked (docs/05
  // §5.4a). pg-boss does not cancel a handler that outruns this — it races the promise against a
  // timer and, on losing, fails the job and hands out another delivery seconds later while the first
  // is still holding buffers and calling Stirling. An hour was below the sum of the per-step budgets
  // §5.4a already documents, so any long scan produced a second run of itself every hour, up to six
  // deliveries, two or three alive at once.
  //
  // Three hours is above that sum: OCR 30 + the merge and the counts 6 + the preview 2 + one whole
  // Docling parse 55 + the transcriber's twenty page renders 40 and its own 20 + the analyst 5 twice
  // + a batch of vectors 2 is 165 minutes, and every one of those is a §5.4a constant rather than a
  // hope. The cost is recovery time: a job whose worker died is invisible for three hours instead of
  // one. That is paid for by the hourly `maintenance` sweep, which re-enqueues a document whose
  // steps have been unstarted for two (docs/05 §5.4) — and by the handler itself, which now refuses
  // to run a document it is already running (`HandleDocumentProcess`).
  'document-process': 3 * 60 * 60,
  // Lists the bucket and deletes a few rows.
  maintenance: 15 * 60,
};

// Graceful shutdown waits for active jobs, capped so a stuck job cannot block exit (docs/06 §6.8).
const STOP_TIMEOUT_MS = 30_000;

// Queues whose work is keyed by an entity get pg-boss's `stately` policy: at most one job queued and
// at most one active per singleton key. That is what makes "one scan per library at a time" hold at
// the database level (docs/05 §5.2, §5.4, docs/06 §6.8) — a plain singletonKey on the default
// `standard` policy does not deduplicate at all.
const SINGLETON_QUEUES: ReadonlySet<QueueName> = new Set(['library-scan']);

// 🔒 And queues where a key means "this work is already waiting" get `short`: at most one job in the
// `created` state per key, with nothing said about what is running (docs/05 §5.4, docs/06 §6.8).
//
// `document-process` was created `standard`, so the singleton keys three call sites already passed
// deduplicated nothing — pg-boss's dedup indexes cover only `short`, `singleton` and `stately` — and
// docs/06 §6.8 claimed the opposite. Every composition edit enqueues a full run at `USER_PRIORITY`,
// so a loop of `PATCH /documents/:id/pages` — a few hundred bytes, always a valid request — queued
// one canonical rebuild, OCR pass, parse, transcription and two analyst completions per request,
// ahead of every other document on the instance.
//
// `short` rather than `stately`, and the difference is the one that matters here: a rebuild asked
// for *while* the previous one runs must still be queued, because it is asking about a document that
// has changed since. What must collapse is the queue of identical requests, and that is exactly the
// `created` state.
const DEBOUNCED_QUEUES: ReadonlySet<QueueName> = new Set(['document-process']);

// Owns the single PgBoss instance for the process (docs/06 §6.8): one connection pool on
// DATABASE_URL, its own `pgboss` schema, which Prisma does not manage (docs/04 §4.2).
@Injectable()
export class PgBossProvider implements OnApplicationShutdown {
  private boss: PgBoss | null = null;
  private starting: Promise<PgBoss> | null = null;

  constructor(private readonly config: AppConfig) {}

  // Idempotent: concurrent callers share one start, so bootstrap and an early enqueue cannot race
  // into two instances.
  start(): Promise<PgBoss> {
    this.starting ??= this.createAndStart();
    return this.starting;
  }

  // Null until started — the monitor uses this to report the queue as down rather than starting it.
  current(): PgBoss | null {
    return this.boss;
  }

  private async createAndStart(): Promise<PgBoss> {
    const boss = new PgBoss({
      connectionString: this.config.get('DATABASE_URL'),
      schema: 'pgboss',
    });

    // pg-boss keeps working after a transient database error; without a listener the emitted error
    // would be an unhandled event and take the process down.
    boss.on('error', () => undefined);

    await boss.start();

    // v10 requires a queue to exist before send/work touches it. createQueue leaves an existing
    // queue untouched, so the options are applied again with updateQueue — otherwise an instance
    // created by an earlier version would keep its old policy and retry settings forever.
    for (const name of QUEUE_NAMES) {
      const options = {
        name,
        policy: policyOf(name),
        retryLimit: RETRY_LIMIT,
        retryBackoff: true,
        expireInSeconds: EXPIRE_IN_SECONDS[name],
      };
      await boss.createQueue(name, options);
      await boss.updateQueue(name, options);
    }

    this.boss = boss;
    return boss;
  }

  async onApplicationShutdown(): Promise<void> {
    const boss = this.boss;
    this.boss = null;
    this.starting = null;
    if (boss === null) return;
    await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS }).catch(() => undefined);
  }
}

// What a singleton key means on a queue, in one place: the queue is created with it here and the key
// itself is decided in `PgBossJobQueue`, and a key on a `standard` queue deduplicates nothing at all.
function policyOf(name: QueueName): 'stately' | 'short' | 'standard' {
  if (SINGLETON_QUEUES.has(name)) return 'stately';
  if (DEBOUNCED_QUEUES.has(name)) return 'short';
  return 'standard';
}
