# Processing outage: safe recovery

## Diagnosis and change

The observed AI gateway returned HTTP 429 without `Retry-After`, sometimes with a deadline in
JSON. The short unavailable breaker then spent retries across the backlog. Document retries
rebuilt completed canonical/preview/Markdown stages. Receipt processing swallowed transient
errors, leaving `FAILED` receipts behind completed jobs. Batch-based consumers refilled only
after their slowest job finished; orphaned `RUNNING` documents escaped maintenance.

The patch adds independent one-job consumers with a shared concurrency limit across restarts,
checkpoint resume, bounded JSON/fallback throttling, transient receipt retries with saved previews,
and transactional recovery of stale document stages which have no live queue delivery.

## Deployment and recovery order

1. Use an administrator session to pause `document-process` and `receipt-process` in
   `/admin/processing/queues`. Pausing stops fetching, not callbacks already running. Retain the
   previous image digest and the normal database backup. Do not clear jobs, statuses or files.
2. Verify the AI gateway's inference quota/credentials. A successful `/models` health check is
   not evidence that an inference request will succeed. Legere cannot repair a provider quota or
   account restriction.
3. Deploy the tested application image through the instance's normal deployment procedure. This
   patch has no schema migration. Do not run old and new application replicas concurrently:
   per-item serialization and service gates follow the existing single-process architecture.
   To move receipts to Ollama, set both `RECEIPT_API_BASE_URL` and `RECEIPT_MODEL` in the app's
   deployment environment, using the configuration in [15 §15.6](../15-receipts.md#156-processing).
   Start its dedicated service concurrency at 1. This isolates receipts from document-provider
   throttling without changing document model settings; blank values retain the legacy provider.
   Verify an actual vision extraction, not only `/models`, before resuming the receipt backlog.
4. Resume the queues conservatively. Service interruptions recorded by the new worker resume from
   persisted checkpoints. Legacy failures and expiry without a checkpoint marker may require one
   fresh run. A crash-abandoned active job remains live until its configured expiry; maintenance
   deliberately does not create competing work for it.
5. The hourly maintenance sweep recovers up to 200 stale documents with unfinished
   `PENDING`/`QUEUED`/`RUNNING` stages and no created, retrying or active job. It preserves completed
   stages and honours held document steps. Failed-job Retry also resumes; explicit document
   reprocess still rebuilds the selected stages.
6. Historical `FAILED` receipts need a separate, reviewed requeue after the provider recovers.
   They cannot be recovered through the failed-job journal if the old handler marked their jobs
   completed. Select only receipt IDs whose errors were confirmed transient, check for existing
   live jobs, and enqueue `receipt-process` through the application's `JobQueue`. Do not reupload,
   delete originals, bulk-reset successful stages, or fabricate raw pg-boss rows. Permanent input
   failures and provider account restrictions require their own correction.

Read-only API tokens and monitoring-only SSH accounts cannot perform deployment, queue-control
mutations or receipt recovery. Use an authorized deployment/operator identity; do not extract
runtime credentials to bypass those boundaries.

## Verification

- `GET /api/admin/processing` is the unified snapshot. `/admin/processing/queues` shows queued,
  active and recently failed jobs, last completion and completions in the last hour.
- `/admin/processing/services` shows actual in-flight calls, waiting callers and `throttledUntil`.
  A provider hold may leave a job active while no request is in flight; that is expected.
- After the provider recovers, `completedLastHour` must increase and the backlog must decrease.
  A retried document must not emit fresh canonical/preview/Markdown starts for stages already done.
- Historical failure counts need not disappear: old failed jobs remain journal history.
- Receipt/document list pages are cursor-paginated. Counting one loaded page is not counting the
  archive; exhaust `nextCursor` and count unique item IDs with the same owner/filter scope.
- Distinguish saved originals, receipt profiles, document profiles and processing jobs. None of
  those counts is interchangeable with another.
