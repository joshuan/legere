import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ContentHash } from '../../domain/value-objects/content-hash';
import type { DocumentRepository } from '../../domain/repositories/document.repository';
import type { FileRefRepository } from '../../domain/repositories/file-ref.repository';
import type { LibraryRepository } from '../../domain/repositories/library.repository';
import type { ScanSetRepository } from '../../domain/repositories/scan-set.repository';
import { toBuffer, type BinarySource } from '../ports/binary-source';
import type { FileStorage } from '../ports/file-storage';
import type { ImageTool } from '../ports/image-tool';
import type { JobQueue } from '../ports/job-queue';
import type { LibraryReader } from '../ports/library-reader';
import type { NamedBinary, PdfToolbox } from '../ports/pdf-toolbox';
import type { UnitOfWork } from '../ports/unit-of-work';
import { artifactKeys } from '../storage/artifact-keys';
import { JobHandler } from './job-handler';
import type { QueueSettings } from '../queue/queue-settings';

export const scanSetMergePayloadSchema = z.object({ scanSetId: z.string().uuid() });
export type ScanSetMergePayload = z.infer<typeof scanSetMergePayloadSchema>;

// How aggressively sharp's trim() decides a pixel is background. A scanner's white is never quite
// white, and a threshold too low leaves a grey frame around every page (docs/05 §5.6).
const TRIM_THRESHOLD = 10;

// `scanset-merge` (docs/05 §5.6): dozens of photographed pages become one PDF document.
//
// The result is a DERIVED document owned by whoever built the set, with its source PDF in the
// bucket and no FileRef anywhere — the originals stay untouched in the library.
export class HandleScanSetMerge extends JobHandler {
  constructor(
    private readonly scanSets: ScanSetRepository,
    private readonly documents: DocumentRepository,
    private readonly fileRefs: FileRefRepository,
    private readonly libraries: LibraryRepository,
    private readonly reader: LibraryReader,
    private readonly files: FileStorage,
    private readonly images: ImageTool,
    private readonly pdfs: PdfToolbox,
    private readonly queue: JobQueue,
    private readonly unitOfWork: UnitOfWork,
    private readonly queueSettings: QueueSettings,
  ) {
    super();
  }

  async handle(rawPayload: unknown): Promise<void> {
    const { scanSetId } = scanSetMergePayloadSchema.parse(rawPayload);

    const scanSet = await this.scanSets.findById(scanSetId);
    if (scanSet === null || scanSet.deletedAt !== null) return;
    // Re-delivery of a job whose set already finished: the work is done (docs/05 §5.4).
    if (scanSet.status === 'DONE') return;

    await this.scanSets.update(scanSetId, { status: 'PROCESSING', error: null });

    try {
      if (scanSet.items.length === 0) throw new Error('The scan set has no pages');

      // The pages are independent work — read one, crop one — so they are prepared `unitConcurrency`
      // at a time (docs/05 §5.4). Order is preserved by position rather than by arrival: page order
      // is the whole point of a scan set (docs/05 §5.6).
      // Read per job rather than at start-up: this knob takes effect on the next merge, with no
      // worker to re-register (docs/11 §11.13).
      const { unitConcurrency } = await this.queueSettings.read();
      const pages = await inBatches(
        [...scanSet.items].sort((a, b) => a.position - b.position),
        unitConcurrency,
        async (item): Promise<NamedBinary> => {
          const source = await this.openPage(item.documentId);
          // TRIM crops the scanner's margin per page before assembly; NONE keeps the frame the
          // photographer chose (docs/05 §5.6).
          const body =
            scanSet.cropMode === 'TRIM'
              ? await this.images.trim(source, TRIM_THRESHOLD)
              : await toBuffer(source);
          return { body, fileName: `page-${String(item.position).padStart(4, '0')}.jpg` };
        },
      );

      const pdf = await this.pdfs.imagesToPdf(pages);
      const contentHash = ContentHash.parse(createHash('sha256').update(pdf).digest('hex'));

      const documentId = await this.unitOfWork.run(async (tx) => {
        // Identical content is the same document (ADR-009): merging the same pages twice attaches
        // the existing result rather than making a duplicate (docs/05 §5.6).
        const { document, created } = await this.documents.findOrCreateByContentHash(
          {
            contentHash: contentHash.value,
            source: 'DERIVED',
            mimeType: 'application/pdf',
            ext: 'pdf',
            sizeBytes: BigInt(pdf.byteLength),
            title: scanSet.name,
            createdById: scanSet.createdById,
            scanSetId,
          },
          tx,
        );

        // Two unique constraints meet here: one active document per content hash (docs/04 §4.3) and
        // one scan set per result document (docs/04 §4.1). Together they make "two different sets,
        // identical merged bytes" impossible to record, so the second set is told plainly rather
        // than silently stealing the first one's result or duplicating the document.
        if (!created) {
          const owner = await this.scanSets.findByResultDocumentId(document.id, tx);
          if (owner !== null && owner.id !== scanSetId) {
            throw new Error(
              `These pages produce a document that already belongs to the scan set "${owner.name}"`,
            );
          }
        }

        if (created) {
          // The pipeline starts only for content nobody has processed before.
          await this.queue.enqueueAfterTx(tx, 'document-process', { documentId: document.id });
        }
        await this.scanSets.update(
          scanSetId,
          { status: 'DONE', resultDocumentId: document.id, error: null },
          tx,
        );
        return { id: document.id, created };
      });

      // Written after the transaction commits: a half-written object with no document pointing at
      // it is easier to sweep than a document pointing at an object that never arrived.
      if (documentId.created) {
        await this.files.put(artifactKeys.source(documentId.id, 'pdf'), pdf, 'application/pdf');
      }
    } catch (error) {
      // The set stays editable: the user fixes what went wrong and merges again (docs/05 §5.6).
      await this.scanSets.update(scanSetId, {
        status: 'FAILED',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // The page images live in a library, so they are read the way any library file is (docs/09 §9.1).
  private async openPage(documentId: string): Promise<BinarySource> {
    const ref = await this.fileRefs.findLiveRefForDocument(documentId);
    if (ref === null) throw new Error(`Page ${documentId} is no longer available`);

    const library = await this.libraries.findById(ref.libraryId);
    if (library === null || library.deletedAt !== null) {
      throw new Error(`Page ${documentId} is in a library that no longer exists`);
    }

    return this.reader.openStream(
      { rootPath: library.rootPath, excludeGlobs: library.excludeGlobs },
      ref.path,
    );
  }
}

// `size` at a time, in order, results in the order they went in. Written here rather than reached
// for from a library: it is six lines, and the alternative is a dependency for six lines.
async function inBatches<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += size) {
    results.push(...(await Promise.all(items.slice(index, index + size).map(work))));
  }
  return results;
}
