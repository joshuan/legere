import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  InMemorySubjectKindRepository,
  InMemorySubjectRepository,
} from '../../../../test/helpers/processing-fakes';
import { InMemoryFileStorage } from '../../infrastructure/storage/in-memory-file-storage';
import { CatalogueIconRenderer } from '../ports/catalogue-icon-renderer';
import { ManageCatalogueIcons } from './manage-catalogue-icons';

class IconRenderer extends CatalogueIconRenderer {
  render(): Promise<Buffer> {
    return Promise.resolve(Buffer.from('rendered image'));
  }
}

describe('ManageCatalogueIcons', () => {
  let kinds: InMemorySubjectKindRepository;
  let subjects: InMemorySubjectRepository;
  let storage: InMemoryFileStorage;
  let renderer: IconRenderer;
  let icons: ManageCatalogueIcons;
  let id: string;

  beforeEach(async () => {
    kinds = new InMemorySubjectKindRepository();
    subjects = new InMemorySubjectRepository(kinds);
    storage = new InMemoryFileStorage();
    renderer = new IconRenderer();
    icons = new ManageCatalogueIcons(subjects, kinds, storage, renderer);
    const kind = await kinds.create({ name: 'Company' });
    id = (await subjects.create({ kindId: kind.id, name: 'Example company' })).id;
  });

  it('keeps the previous image if rendering fails', async () => {
    const previous = await icons.upload('subjects', id, Buffer.from('first'));
    const before = [...storage.objects.keys()];
    vi.spyOn(renderer, 'render').mockRejectedValueOnce(new Error('invalid image'));
    await expect(icons.upload('subjects', id, Buffer.from('second'))).rejects.toThrow(
      'invalid image',
    );
    expect([...storage.objects.keys()]).toEqual(before);
    expect((await subjects.findById(id))?.icon).toEqual(previous.icon);
  });

  it('removes the new artifact and keeps the previous one when metadata cannot be saved', async () => {
    const previous = await icons.upload('subjects', id, Buffer.from('first'));
    const before = [...storage.objects.keys()];
    vi.spyOn(subjects, 'update').mockRejectedValueOnce(new Error('database unavailable'));
    await expect(icons.upload('subjects', id, Buffer.from('second'))).rejects.toThrow(
      'database unavailable',
    );
    expect([...storage.objects.keys()]).toEqual(before);
    expect((await subjects.findById(id))?.icon).toEqual(previous.icon);
  });

  it('does not turn a successful icon change into a failure when old-image cleanup fails', async () => {
    await icons.upload('subjects', id, Buffer.from('first'));
    vi.spyOn(storage, 'delete').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(icons.setSymbol('subjects', id, 'bank')).resolves.toEqual({
      icon: { type: 'symbol', symbol: 'bank' },
    });
    await expect(icons.image('subjects', id)).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('does not serve an image for a deleted row or change a missing catalogue row', async () => {
    await icons.upload('subjects', id, Buffer.from('first'));
    await subjects.softDelete(id, new Date());
    await expect(icons.image('subjects', id)).rejects.toMatchObject({ httpStatus: 404 });
    await expect(icons.setSymbol('subject-kinds', 'missing', null)).rejects.toMatchObject({
      httpStatus: 404,
    });
  });
});
