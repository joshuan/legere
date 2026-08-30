import {
  SUBJECT_KIND_NOTE_LIMIT,
  type SubjectKindMergePreviewRequest,
  type SubjectKindMergePreviewResponse,
  type SubjectKindMergeSuggestionGroup,
  type SubjectKindMergeSuggestionsResponse,
} from '../../../shared/contracts/subject-kinds';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import { SuggestionCache, cutNote, sanitizeGroups } from '../catalogues/catalogue-suggestions';
import type { CatalogueAnalyst, CatalogueRow } from '../ports/catalogue-analyst';
import type { Clock } from '../ports/clock';

// The kinds merge contract's own bound (docs/07 §7.3): a longer name is one the merge would refuse.
const MAX_NAME = 40;

// Which kinds are one shelf (docs/05 §5.6c) — the smallest catalogue, and the one whose duplicates
// split every shelf under them. `computedAt` dates the cached reading, and `refresh` drops it and
// asks anew — the recompute of docs/11 §11.12a.
export class SuggestSubjectKindMerges {
  private readonly cache: SuggestionCache<SubjectKindMergeSuggestionGroup[]>;

  constructor(
    private readonly kinds: SubjectKindRepository,
    private readonly analyst: CatalogueAnalyst,
    clock: Clock,
  ) {
    this.cache = new SuggestionCache(() => clock.now());
  }

  async execute(options?: { refresh?: boolean }): Promise<SubjectKindMergeSuggestionsResponse> {
    if (!this.analyst.isConfigured) {
      return { state: 'UNCONFIGURED', computedAt: null, groups: [] };
    }

    const rows = (await this.kinds.listActive()).map((kind): CatalogueRow => ({
      id: kind.id,
      name: kind.name,
      note: kind.note,
    }));
    const reading = await this.cache.answer(
      JSON.stringify(rows),
      async () =>
        sanitizeGroups(
          (await this.analyst.suggestMerges('subject-kinds', rows)).groups,
          rows,
          MAX_NAME,
          SUBJECT_KIND_NOTE_LIMIT,
        ).map((group) => ({ ids: group.ids, name: group.name, aka: group.aka, note: group.note })),
      options,
    );
    if (!reading.answered) return { state: 'UNAVAILABLE', computedAt: null, groups: [] };
    return {
      state: 'ANSWERED',
      computedAt: reading.computedAt.toISOString(),
      groups: reading.value,
    };
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

    if (!this.analyst.isConfigured) return { available: false, name: null, aka: null, note: null };

    try {
      const preview = await this.analyst.previewMerge(
        'subject-kinds',
        rows.map((kind) => ({ id: kind.id, name: kind.name, note: kind.note })),
      );
      // A name the merge contract would refuse is no preview at all (docs/07 §7.3).
      if (preview === null || preview.name.length > MAX_NAME) {
        return { available: false, name: null, aka: null, note: null };
      }
      return {
        available: true,
        name: preview.name,
        aka: preview.aka,
        note: cutNote(preview.note, SUBJECT_KIND_NOTE_LIMIT),
      };
    } catch {
      return { available: false, name: null, aka: null, note: null };
    }
  }
}
