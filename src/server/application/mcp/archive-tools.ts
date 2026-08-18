import {
  MCP_READ_DOCUMENT_DEFAULT_LIMIT,
  getDocumentInputSchema,
  readDocumentInputSchema,
  searchDocumentsInputSchema,
} from '../../../shared/contracts/mcp';
import { availabilityOf } from '../../domain/entities/document';
import type { DocumentRepository, Viewer } from '../../domain/repositories/document.repository';
import type { SearchDocuments } from '../search/search-documents';

// What the archive can be asked (docs/07 §7.3a, ADR-024). A closed list over read use cases: "the
// tools are read-only" is a property of this registry rather than a promise about what somebody
// mounts next, which is what lets `08 §8.2a` keep its sentence about a token that can never write.
//
// Every answer is one JSON text block. A model reads structured text better than prose it has to
// parse back, and worse than nothing at all when the shape changes between calls — so the shapes
// are fixed here and documented in `07 §7.3a`.
export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type ToolResult = { text: string; isError?: boolean };

export class ArchiveTools {
  constructor(
    private readonly search: SearchDocuments,
    private readonly documents: DocumentRepository,
    // Where this instance answers, so an assistant can cite a document instead of describing it.
    private readonly baseUrl: string,
  ) {}

  list(): ToolDefinition[] {
    return [
      {
        name: 'search_documents',
        title: 'Search the archive',
        description:
          'Search this archive by words and by meaning at once. Matches titles, the fields read ' +
          'off each paper, descriptions, the extracted text, places, and the names of files, ' +
          'people and things. Every row says which of those matched.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to look for.' },
            mode: {
              type: 'string',
              enum: ['hybrid', 'text', 'semantic'],
              description:
                'hybrid (default) fuses words and meaning; text matches the words; semantic ' +
                'matches the meaning of the sentence. Semantic needs an embeddings provider.',
            },
            limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Rows, at most 20.' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      },
      {
        name: 'get_document',
        title: 'What is known about one document',
        description:
          'Everything the archive knows about one document: what it is, when it is dated, where ' +
          'it happened, who and what it is about, and whether any text was ever extracted from it.',
        inputSchema: {
          type: 'object',
          properties: { documentId: { type: 'string', description: 'The document id (uuid).' } },
          required: ['documentId'],
          additionalProperties: false,
        },
      },
      {
        name: 'read_document',
        title: 'Read a document',
        description:
          'The text extracted from a document, in slices. A long scan does not fit a context ' +
          'window, so the answer carries totalChars and nextOffset; ask again from there.',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'The document id (uuid).' },
            offset: { type: 'integer', minimum: 0, description: 'Where to start, in characters.' },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 50_000,
              description: `Characters to read; ${MCP_READ_DOCUMENT_DEFAULT_LIMIT} by default.`,
            },
          },
          required: ['documentId'],
          additionalProperties: false,
        },
      },
    ];
  }

  // 🔒 Every tool runs under the caller's own access rule, which is the token owner's (docs/08
  // §8.2a): a document in a library they were never granted is not in an answer, and not found and
  // not allowed read alike — telling an assistant that a document exists is a disclosure too.
  async call(viewer: Viewer, name: string, args: unknown): Promise<ToolResult> {
    if (name === 'search_documents') return this.searchDocuments(viewer, args);
    if (name === 'get_document') return this.getDocument(viewer, args);
    if (name === 'read_document') return this.readDocument(viewer, args);
    return { text: `There is no tool called ${name}.`, isError: true };
  }

  private async searchDocuments(viewer: Viewer, args: unknown): Promise<ToolResult> {
    const input = searchDocumentsInputSchema.safeParse(args ?? {});
    if (!input.success) return invalid(input.error.issues[0]?.message ?? 'bad arguments');

    const answer = await this.search.execute(viewer, {
      q: input.data.query,
      mode: input.data.mode ?? 'hybrid',
      limit: input.data.limit ?? 10,
    });

    return json({
      // Said out loud rather than left to be inferred from an empty list: a mode that quietly
      // degraded is the difference between "not here" and "not searched" (docs/11 §11.6).
      semanticAvailable: answer.semanticAvailable,
      results: answer.items.map((hit) => ({
        id: hit.document.id,
        title: hit.document.title,
        documentType: hit.document.documentType?.name ?? null,
        documentDate: hit.document.documentDate,
        place: placeOf(hit.document.city, hit.document.country),
        // The markup is the browser's business; a model reads the sentence (docs/07 §7.3a).
        snippet: hit.snippet === null ? null : stripMarks(hit.snippet),
        matchedIn: hit.matchedIn,
        url: this.urlOf(hit.document.id),
      })),
    });
  }

  private async getDocument(viewer: Viewer, args: unknown): Promise<ToolResult> {
    const input = getDocumentInputSchema.safeParse(args ?? {});
    if (!input.success) return invalid(input.error.issues[0]?.message ?? 'bad arguments');

    const detail = await this.documents.findReadableById(input.data.documentId, viewer);
    if (detail === null) return notFound();

    const markdown = detail.document.markdown ?? '';
    return json({
      id: detail.document.id,
      title: detail.document.title,
      description: detail.document.description,
      documentType: detail.documentType?.name ?? null,
      documentDate: detail.document.documentDate,
      place: placeOf(detail.document.city, detail.document.country),
      languages: detail.document.languages,
      people: detail.people.map((person) => person.name),
      subjects: detail.subjects.map((subject) => `${subject.kind}: ${subject.name}`),
      pageCount: detail.document.pageCount,
      fileCount: detail.files.length,
      // Derived from the files, exactly as a list row derives it (docs/03 §3.3.10): whether the
      // originals behind this document can still be read.
      availability: availabilityOf(detail.files.map((file) => file.available)),
      addedAt: detail.document.createdAt.toISOString(),
      // What `read_document` will have to work with, so an assistant knows before it asks.
      textChars: markdown.length,
      url: this.urlOf(detail.document.id),
    });
  }

  private async readDocument(viewer: Viewer, args: unknown): Promise<ToolResult> {
    const input = readDocumentInputSchema.safeParse(args ?? {});
    if (!input.success) return invalid(input.error.issues[0]?.message ?? 'bad arguments');

    const detail = await this.documents.findReadableById(input.data.documentId, viewer);
    if (detail === null) return notFound();

    const markdown = detail.document.markdown ?? '';
    const offset = Math.min(input.data.offset ?? 0, markdown.length);
    const limit = input.data.limit ?? MCP_READ_DOCUMENT_DEFAULT_LIMIT;
    const text = markdown.slice(offset, offset + limit);
    const end = offset + text.length;

    return json({
      id: detail.document.id,
      title: detail.document.title,
      totalChars: markdown.length,
      offset,
      // Null when there is no more of it, so "keep asking" needs no arithmetic on the other side.
      nextOffset: end < markdown.length ? end : null,
      // An honest empty rather than a silence: a document whose extraction failed has no text, and
      // that is a fact about the document rather than a failure of this call (docs/05 §5.5).
      text,
    });
  }

  private urlOf(documentId: string): string {
    return `${this.baseUrl.replace(/\/$/, '')}/documents/${documentId}`;
  }
}

function json(value: unknown): ToolResult {
  return { text: JSON.stringify(value, null, 2) };
}

function invalid(message: string): ToolResult {
  return { text: `Those arguments do not fit this tool: ${message}.`, isError: true };
}

// 🔒 One answer for missing, deleted and not-allowed alike (docs/08 §8.5).
function notFound(): ToolResult {
  return { text: 'No such document in this archive.', isError: true };
}

function stripMarks(snippet: string): string {
  return snippet.replaceAll('<mark>', '').replaceAll('</mark>', '');
}

function placeOf(city: string | null, country: string | null): string | null {
  const parts = [city, country].filter((part): part is string => part !== null && part !== '');
  return parts.length === 0 ? null : parts.join(', ');
}
