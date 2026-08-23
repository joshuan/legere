import type {
  SubjectKindMergePreviewRequest,
  SubjectKindMergePreviewResponse,
  SubjectKindMergeSuggestionGroup,
  SubjectKindMergeSuggestionsResponse,
} from '../../../shared/contracts/subject-kinds';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import { SuggestionCache, sanitizeGroups } from '../catalogues/catalogue-suggestions';
import type { CatalogueAnalyst, CatalogueRow } from '../ports/catalogue-analyst';

// The kinds merge contract's own bound (docs/07 §7.3): a longer name is one the merge would refuse.
const MAX_NAME = 40;

// Which kinds are one shelf (docs/05 §5.6c) — the smallest catalogue, and the one whose duplicates
// split every shelf under them.
export class SuggestSubjectKindMerges {
  private readonly cache = new SuggestionCache<SubjectKindMergeSuggestionGroup[]>();

  constructor(
    private readonly kinds: SubjectKindRepository,
    private readonly analyst: CatalogueAnalyst,
  ) {}

  async execute(): Promise<SubjectKindMergeSuggestionsResponse> {
    if (!this.analyst.isConfigured) return { configured: false, groups: [] };

    const rows = (await this.kinds.listActive()).map((kind): CatalogueRow => ({
      id: kind.id,
      name: kind.name,
      note: kind.note,
    }));
    const groups = await this.cache.answer(
      JSON.stringify(rows),
      async () =>
        sanitizeGroups((await this.analyst.suggestMerges(rows)).groups, rows, MAX_NAME).map(
          (group) => ({ ids: group.ids, name: group.name, aka: group.aka }),
        ),
      [],
    );
    return { configured: true, groups };
  }
}

export class PreviewSubjectKindMerge {
  constructor(
    private readonly kinds: SubjectKindRepository,
    private readonly analyst: CatalogueAnalyst,
  ) {}

  async execute(input: SubjectKindMergePreviewRequest): Promise<SubjectKindMergePreviewResponse> {
    const rows = await this.kinds.findByIds(input.ids);
    if (rows.length !== input.ids.length) {
      throw new NotFoundError('SUBJECT_KIND_NOT_FOUND', 'Subject kind not found');
    }

    if (!this.analyst.isConfigured) return { available: false, name: null, aka: null };

    try {
      const preview = await this.analyst.previewMerge(
        rows.map((kind) => ({ id: kind.id, name: kind.name, note: kind.note })),
      );
      // A name the merge contract would refuse is no preview at all (docs/07 §7.3).
      if (preview === null || preview.name.length > MAX_NAME) {
        return { available: false, name: null, aka: null };
      }
      return { available: true, name: preview.name, aka: preview.aka };
    } catch {
      return { available: false, name: null, aka: null };
    }
  }
}
