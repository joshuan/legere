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
   `/admin/processing`. Pausing stops fetching, not callbacks already running. Retain the
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

- `GET /api/admin/processing` is the unified snapshot. `/admin/processing` shows queued,
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

## October 4 verification

The production app at version 0.42.0 was running without a container restart or OOM. Health,
document listing, document detail and processing administration opened successfully in the existing
browser session. The original browser failure was not reproduced.

Stirling 2.14.3 and Docling run as native launchd services on the operator's Mac, under
`/opt/doc-process`, on ports 8088 and 5001. Docker containers with similar names belonged to the
old `projects/legere-test` stack. Its app was in a restart loop because its database was stopped;
that app and its unpublished, approximately 1 GiB Stirling container were stopped. Production
uses the native services, which remained available.

The native Stirling log correlates the October 3 22:00–22:02 local failures with
`No space left on device`: OCR output and Jetty multipart temporary files could not be written.
At recovery time the volume already had 177 GiB available; no original or temporary file cleanup
was needed for this recovery. Four affected documents were explicitly reprocessed through the
administrator UI and completed canonical PDF, preview, Markdown and analysis. The legacy
347.1 Mpx preview was recovered by rebuilding its canonical PDF and preview only. This reduced
the failed counts from canonical 6 / preview 7 / Markdown 6 to 2 / 2 / 2, out of 4,741 documents.

Both remaining original PDFs were checked independently with Poppler and qpdf. One ends within
an object and lacks its trailer and cross-reference table; qpdf could not reconstruct it. The other
requires a nonempty password. They require a complete original and an unlocked copy respectively.
Repeated pipeline retries cannot supply missing source bytes or a password.

The 20 retained receipt job failures involved ten receipt IDs, all now successfully extracted;
two outstanding receipts completed at 14:02–14:03 local time. This history is distinct from 954
older failed receipt profiles: 941 record September service/429 interruptions and 13 record empty
structured extraction. Their separate recovery is described below.

A separate 544-page document repeatedly exhausted the embeddings request's two-minute timeout.
The HTTP adapter sent all document chunks in one request. M79 bounds requests to four chunks,
with separate gate admission and timeout per batch and atomic replacement only after all succeed.
The patch was published as 0.42.1 through the normal CI-gated release command and deployed with
an authorized operator SSH identity on October 4 at 13:04 UTC. The previous application image
and environment file were retained for rollback. Only the application container was replaced;
the native parsing services remained in place. Document and receipt queues were drained and
temporarily paused, then both resumed. The running container and browser report 0.42.1, and
the database and queue health checks pass. The approved embeddings concurrency is now one.
The long document completed vectorization in 841,509 ms (about 14 minutes): all 400 requests
succeeded and all 1,600 chunks were committed. Its completed PDF, preview and Markdown stages
were preserved. The archive now has 4,723 vectorized documents and 65,406 chunks.
Add free-space monitoring for the Mac's temporary volume, and distinguish historical
job failures from current document/profile failures when assessing whether recovery worked.

The browser journal also logged missing `viewer.details.crop` and `viewer.details.turn`
translations in Russian. Both labels are restored in the English and Russian catalogs in 0.42.1;
the historical crop event now displays both labels without a browser localization error.
This was a reproducible journal-label error; it was not evidence of a server outage.

A five-receipt trial from the historical backlog completed successfully, increasing the completed
count from 6,893 to 6,898 and reducing failed profiles from 954 to 949. The 13 empty-result sources
include readable receipts and bank payment confirmations, alongside a severely faded receipt;
an empty model answer is not by itself evidence of a corrupt original.

After the long document completed, the remaining 949 failed receipt profiles were queued through
the administrator action in five batches (200, 200, 200, 200 and 149). This preserves originals
and completed previews. The transition to queued is not a successful extraction: completion and
new errors must be assessed independently while the backlog drains.
At 13:27 UTC the completed count had risen to 6,900. A five-minute inference timeout was followed
by the existing 30-second breaker and then successful 33- and 15-second extractions. No new
terminal failed jobs were recorded at that checkpoint. Five newly discovered receipts also entered
the archive during recovery: the live totals were 7,852 receipts, 6,900 done, 950 queued, two
running and zero failed profiles. This is a verified background recovery, not a claim that every
queued receipt has finished. The original timeout remains subject to the normal retry policy.

Further findings from the retained server logs:

- Receipt timeouts were followed by many fast unavailable-breaker refusals. These consume retry
  attempts while the service's 30-second unavailable window is still open; exponential retries
  allowed work to resume in the observed recovery. Deferring work until the breaker deadline
  remains a separate resilience improvement that would avoid those redundant failed attempts.
- The older receipt failures were admitted through the existing administrator action after the
  successful five-receipt trial. The 13 empty structured results need individual
  source/extraction review if they recur.
- Nine Caddy 502 responses coincided with the October 3 app replacement, around 18:22:25–32 UTC.
  They do not establish a continuing outage. The current app had no container restart or OOM.
- `TRUST_PROXY` was unset although requests arrive through Caddy. The verified deployment has
  one host-network Caddy forwarding to a loopback-only application port, without upstream trusted
  proxies. The application now trusts only the exact Docker host gateway address, preserving
  client rate-limit identities without trusting arbitrary peers or widening the published port.
- Four preview 404s matched failed document rebuilds. Stream-cancellation warnings can occur when
  a reader cancels a download or navigates away. Neither category alone proves a service outage.
- Three processing-control 409 responses were revision conflicts. UI controls share one aggregate
  revision; serializing settings mutations or refreshing before the next save avoids stale writes.
