import type {
  ArchiveDocumentDto,
  ArchiveDocumentsQuery,
} from '../../../shared/contracts/archive-integration';

export type PersonalArchiveDocument = Omit<ArchiveDocumentDto, 'processing' | 'url'>;

// A separate read model: neither administrator roles nor shares can broaden this permission.
export abstract class PersonalArchiveRepository {
  abstract list(
    subject: string,
    query: ArchiveDocumentsQuery,
  ): Promise<{
    items: PersonalArchiveDocument[];
    nextCursor: string | null;
  }>;
  abstract find(subject: string, id: string): Promise<PersonalArchiveDocument | null>;
}
