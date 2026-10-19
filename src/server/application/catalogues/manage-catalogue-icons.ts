import { randomUUID } from 'node:crypto';
import type {
  CatalogueIcon,
  CatalogueIconTarget,
  CatalogueSymbol,
} from '../../../shared/contracts/catalogue-icons';
import { NotFoundError } from '../../domain/errors/domain-error';
import type { SubjectRepository } from '../../domain/repositories/subject.repository';
import type { SubjectKindRepository } from '../../domain/repositories/subject-kind.repository';
import type { FileStorage } from '../ports/file-storage';
import type { CatalogueIconRenderer } from '../ports/catalogue-icon-renderer';

function imageKey(target: CatalogueIconTarget, id: string, revision: string): string {
  return `catalogue-icons/${target}/${id}/${revision}.webp`;
}

export class ManageCatalogueIcons {
  constructor(
    private readonly subjects: SubjectRepository,
    private readonly kinds: SubjectKindRepository,
    private readonly storage: FileStorage,
    private readonly renderer: CatalogueIconRenderer,
  ) {}

  async setSymbol(
    target: CatalogueIconTarget,
    id: string,
    symbol: CatalogueSymbol | null,
  ): Promise<{ icon: CatalogueIcon | null }> {
    const previous = await this.current(target, id);
    const icon: CatalogueIcon | null = symbol === null ? null : { type: 'symbol', symbol };
    await this.save(target, id, icon);
    await this.removeImage(target, id, previous);
    return { icon };
  }

  async upload(
    target: CatalogueIconTarget,
    id: string,
    bytes: Buffer,
  ): Promise<{ icon: CatalogueIcon }> {
    const previous = await this.current(target, id);
    const rendered = await this.renderer.render(bytes);
    const icon: CatalogueIcon = { type: 'image', revision: randomUUID() };
    const key = imageKey(target, id, icon.revision);
    await this.storage.put(key, rendered, 'image/webp');
    try {
      await this.save(target, id, icon);
    } catch (error) {
      await this.storage.delete(key).catch(() => undefined);
      throw error;
    }
    await this.removeImage(target, id, previous);
    return { icon };
  }

  async image(target: CatalogueIconTarget, id: string): Promise<string> {
    const icon = await this.current(target, id);
    if (icon?.type !== 'image') throw new NotFoundError('NOT_FOUND', 'Catalogue image not found');
    return this.storage.getSignedUrl(imageKey(target, id, icon.revision), 120, {
      disposition: 'inline',
      contentType: 'image/webp',
    });
  }

  private async current(target: CatalogueIconTarget, id: string): Promise<CatalogueIcon | null> {
    const row =
      target === 'subjects' ? await this.subjects.findById(id) : await this.kinds.findById(id);
    if (row === null || row.deletedAt !== null)
      throw new NotFoundError('NOT_FOUND', 'Catalogue row not found');
    return row.icon;
  }

  private async save(
    target: CatalogueIconTarget,
    id: string,
    icon: CatalogueIcon | null,
  ): Promise<void> {
    if (target === 'subjects') await this.subjects.update(id, { icon });
    else await this.kinds.update(id, { icon });
  }

  private async removeImage(
    target: CatalogueIconTarget,
    id: string,
    icon: CatalogueIcon | null,
  ): Promise<void> {
    if (icon?.type === 'image') {
      await this.storage.delete(imageKey(target, id, icon.revision)).catch(() => undefined);
    }
  }
}
