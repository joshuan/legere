import type {
  SubjectMergePreviewRequest,
  SubjectMergePreviewResponse,
  SubjectMergeSuggestionsResponse,
} from '../../../shared/contracts/subjects';
import type { Subject } from '../../domain/entities/subject';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { SubjectRepository } from '../../domain/repositories/subject.repository';
import { foldName } from '../../domain/value-objects/name-fold';
import { SuggestionCache, sanitizeGroups } from '../catalogues/catalogue-suggestions';
import type { CatalogueAnalyst, CatalogueRow } from '../ports/catalogue-analyst';

const MAX_NAME = 200;
const MAX_PLACEHOLDERS = 20;

type Answer = Pick<SubjectMergeSuggestionsResponse, 'groups' | 'placeholders'>;

// The kind the survivor keeps, resolved against the kinds the merged rows already have
// (docs/03 §3.3.20): the model answers a kind *name*, and only a name one of the grouped rows is
// filed under counts — the merge endpoint will not invent a shelf. Matched on the fold, since the
// model may echo the kind in another case.
function resolveKindId(kind: string | undefined, members: readonly Subject[]): string | null {
  if (kind === undefined) return null;
  const fold = foldName(kind);
  return members.find((member) => foldName(member.kind) === fold)?.kindId ?? null;
}

// Which things are one thing (docs/05 §5.6c), kind-aware: the duplicates worth finding sit across
// duplicate kinds as often as inside one.
export class SuggestSubjectMerges {
  private readonly cache = new SuggestionCache<Answer>();

  constructor(
    private readonly subjects: SubjectRepository,
    private readonly analyst: CatalogueAnalyst,
  ) {}

  async execute(): Promise<SubjectMergeSuggestionsResponse> {
    if (!this.analyst.isConfigured) return { configured: false, groups: [], placeholders: [] };

    const living = await this.subjects.listActive();
    const byId = new Map(living.map((subject) => [subject.id, subject]));
    const rows = living.map((subject): CatalogueRow => ({
      id: subject.id,
      name: subject.name,
      note: subject.note,
      kind: subject.kind,
    }));

    const answer = await this.cache.answer(
      JSON.stringify(rows),
      async () => {
        const suggested = await this.analyst.suggestMerges(rows);
        const groups = sanitizeGroups(suggested.groups, rows, MAX_NAME).flatMap((group) => {
          const members = group.ids.flatMap((id) => {
            const member = byId.get(id);
            return member === undefined ? [] : [member];
          });
          // A group whose kind the merged rows do not carry is dropped whole: a suggestion the
          // merge endpoint would refuse is not a suggestion (docs/03 §3.3.20).
          const kindId = resolveKindId(group.kind, members);
          if (kindId === null) return [];
          return [{ ids: group.ids, name: group.name, kindId, aka: group.aka }];
        });
        // The placeholders pass the same living check as the groups: an id the model made up names
        // nothing (docs/05 §5.6c).
        const placeholders = [...new Set(suggested.placeholders)]
          .filter((id) => byId.has(id))
          .slice(0, MAX_PLACEHOLDERS);
        return { groups, placeholders };
      },
      { groups: [], placeholders: [] },
    );
    return { configured: true, ...answer };
  }
}

// The tidy reading for a hand-picked selection, the kind included (docs/11 §11.12a).
export class PreviewSubjectMerge {
  constructor(
    private readonly subjects: SubjectRepository,
    private readonly analyst: CatalogueAnalyst,
  ) {}

  async execute(input: SubjectMergePreviewRequest): Promise<SubjectMergePreviewResponse> {
    const rows = await this.subjects.findByIds(input.ids);
    if (rows.length !== input.ids.length) {
      throw new NotFoundError('SUBJECT_NOT_FOUND', 'Subject not found');
    }

    if (!this.analyst.isConfigured) {
      return { available: false, name: null, kindId: null, aka: null };
    }

    try {
      const preview = await this.analyst.previewMerge(
        rows.map((subject) => ({
          id: subject.id,
          name: subject.name,
          note: subject.note,
          kind: subject.kind,
        })),
      );
      if (preview === null) return { available: false, name: null, kindId: null, aka: null };
      // An unresolvable kind costs the kind, not the preview: the dialog keeps the kind it opened
      // with (docs/07 §7.3).
      return {
        available: true,
        name: preview.name,
        kindId: resolveKindId(preview.kind, rows),
        aka: preview.aka,
      };
    } catch {
      return { available: false, name: null, kindId: null, aka: null };
    }
  }
}
