import type {
  DocumentLinkDto,
  DocumentLinkSuggestionsResponse,
  DocumentLinksResponse,
} from '../../../shared/contracts/documents';
import { canEditDocumentMeta } from '../../domain/entities/document';
import { linkProbeTokens, orderedPair } from '../../domain/entities/document-link';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../domain/errors/domain-error';
import type { DocumentEventRepository } from '../../domain/repositories/document-event.repository';
import type { DocumentLinkRepository } from '../../domain/repositories/document-link.repository';
import type {
  DocumentDetail,
  DocumentListItem,
  DocumentRepository,
  Viewer,
} from '../../domain/repositories/document.repository';
import type { Clock } from '../ports/clock';
import { listItemOf, originOfDetail, toListDto } from './manage-documents';

// The edges of one document (docs/03 §3.3.23, docs/07 §7.3): undirected, untyped, person-made.
// 🔒 An edge whose other side the caller may not read is absent from every answer here — not
// present, not redacted — which is the collection-item rule, applied to a different join.

// How many candidates a suggestion answer holds, and how many documents one probe may pull in
// before the merge (docs/05 §5.6b).
const MAX_SUGGESTIONS = 5;
const PROBE_LIMIT = 10;

export class ListDocumentLinks {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly links: DocumentLinkRepository,
  ) {}

  async execute(viewer: Viewer, detail: DocumentDetail): Promise<DocumentLinksResponse> {
    const edges = await this.links.listForDocument(detail.document.id);
    const readable = await this.documents.listReadableItems(
      viewer,
      edges.map((edge) => edge.otherDocumentId),
    );
    const byId = new Map(readable.map((item) => [item.document.id, item] as const));
    return {
      items: edges.flatMap((edge) => {
        const item = byId.get(edge.otherDocumentId);
        if (item === undefined) return [];
        return [{ document: toListDto(item), linkedAt: edge.linkedAt.toISOString() }];
      }),
    };
  }
}

export class CreateDocumentLink {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly links: DocumentLinkRepository,
    private readonly events: DocumentEventRepository,
    private readonly clock: Clock,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    otherDocumentId: string,
  ): Promise<DocumentLinkDto> {
    if (otherDocumentId === detail.document.id) {
      throw new UnprocessableError('LINK_SELF', 'A document cannot be linked to itself');
    }
    if (!canEditDocumentMeta(viewer, detail.document, originOfDetail(detail))) {
      throw new ForbiddenError('You may not edit this document');
    }
    // Read access on the other end, under the same rule as everywhere: a link is a claim about
    // both documents, and one the caller cannot read is one that is not found (docs/03 §3.3.23).
    const other = await this.documents.findReadableById(otherDocumentId, viewer);
    if (other === null) {
      throw new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
    }

    const pair = orderedPair(detail.document.id, otherDocumentId);
    if (await this.links.exists(pair)) {
      throw new ConflictError('LINK_EXISTS', 'These two documents are already linked');
    }
    const at = this.clock.now();
    await this.links.create(pair, viewer.id, at);

    // On both documents, as a record (docs/03 §3.3.18): the id may point at nothing later, the
    // title still says which paper it was.
    await this.recordEdge('LINKED', viewer.id, detail.document, other.document);

    return { document: toListDto(listItemOf(other)), linkedAt: at.toISOString() };
  }

  private async recordEdge(
    type: 'LINKED' | 'UNLINKED',
    actorId: string,
    a: { id: string; title: string },
    b: { id: string; title: string },
  ): Promise<void> {
    await this.events.record({
      documentId: a.id,
      type,
      actorId,
      payload: { otherDocumentId: b.id, otherTitle: b.title },
    });
    await this.events.record({
      documentId: b.id,
      type,
      actorId,
      payload: { otherDocumentId: a.id, otherTitle: a.title },
    });
  }
}

export class DeleteDocumentLink {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly links: DocumentLinkRepository,
    private readonly events: DocumentEventRepository,
  ) {}

  async execute(
    viewer: Viewer,
    detail: DocumentDetail,
    otherDocumentId: string,
  ): Promise<{ ok: true }> {
    // Either end suffices (docs/03 §3.4): an edge belongs to both. The other end is only consulted
    // when the near one refuses — and through the access rule, because an edit right on a document
    // the caller cannot read is no right at all.
    if (!canEditDocumentMeta(viewer, detail.document, originOfDetail(detail))) {
      const other = await this.documents.findReadableById(otherDocumentId, viewer);
      if (other === null || !canEditDocumentMeta(viewer, other.document, originOfDetail(other))) {
        throw new ForbiddenError('You may not edit this document');
      }
    }

    const removed = await this.links.remove(orderedPair(detail.document.id, otherDocumentId));
    if (!removed) {
      throw new NotFoundError('LINK_NOT_FOUND', 'There is no link between these documents');
    }

    // The record survives the edge — that is what the journal is for (docs/03 §3.3.23). The other
    // side is read without the access rule here: the entry belongs on both documents whoever
    // removed the edge.
    const other = await this.documents.findById(otherDocumentId);
    await this.events.record({
      documentId: detail.document.id,
      type: 'UNLINKED',
      actorId: viewer.id,
      payload: { otherDocumentId, ...(other === null ? {} : { otherTitle: other.title }) },
    });
    if (other !== null) {
      await this.events.record({
        documentId: other.id,
        type: 'UNLINKED',
        actorId: viewer.id,
        payload: { otherDocumentId: detail.document.id, otherTitle: detail.document.title },
      });
    }
    return { ok: true };
  }
}

export class SuggestDocumentLinks {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly links: DocumentLinkRepository,
  ) {}

  // Deterministic and stateless (docs/05 §5.6b): the document's own identifiers, each probed as one
  // FTS phrase query under the caller's access rule; candidates rank by probes answered, then by
  // when they last changed; nothing is stored in either direction.
  async execute(viewer: Viewer, detail: DocumentDetail): Promise<DocumentLinkSuggestionsResponse> {
    const probes = linkProbeTokens(detail.document);
    if (probes.length === 0) return { items: [] };

    const excluded = new Set<string>([detail.document.id]);
    for (const edge of await this.links.listForDocument(detail.document.id)) {
      excluded.add(edge.otherDocumentId);
    }

    const candidates = new Map<string, { item: DocumentListItem; matchedTokens: string[] }>();
    for (const probe of probes) {
      const matches = await this.documents.searchByText(viewer, `"${probe}"`, {}, PROBE_LIMIT);
      for (const match of matches) {
        const id = match.item.document.id;
        if (excluded.has(id)) continue;
        const candidate = candidates.get(id);
        if (candidate === undefined) {
          candidates.set(id, { item: match.item, matchedTokens: [probe] });
        } else if (!candidate.matchedTokens.includes(probe)) {
          candidate.matchedTokens.push(probe);
        }
      }
    }

    const ranked = [...candidates.values()].sort(
      (a, b) =>
        b.matchedTokens.length - a.matchedTokens.length ||
        b.item.document.lastEventAt.getTime() - a.item.document.lastEventAt.getTime(),
    );
    return {
      items: ranked.slice(0, MAX_SUGGESTIONS).map((candidate) => ({
        document: toListDto(candidate.item),
        matchedTokens: candidate.matchedTokens,
      })),
    };
  }
}
