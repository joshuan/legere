import { beforeEach, describe, expect, it } from 'vitest';
import { InMemorySettingsRepository } from '../../../../test/helpers/processing-fakes';
import { QUEUE_SETTINGS_KEY, QueueSettings, type QueueDefaults } from './queue-settings';

// The stored `queue` setting (docs/03 §3.3.21, docs/05 §5.4): env is the default, a row is somebody
// overriding one deliberately, and a value this version does not recognise is ignored rather than
// stopping the workers from starting.
describe('QueueSettings', () => {
  const defaults: QueueDefaults = {
    concurrency: {
      'library-scan': 1,
      'file-ingest': 4,
      'document-process': 2,
      maintenance: 1,
    },
    unitConcurrency: 1,
  };

  let store: InMemorySettingsRepository;
  let settings: QueueSettings;

  beforeEach(() => {
    store = new InMemorySettingsRepository();
    settings = new QueueSettings(store, defaults);
  });

  it('answers with the env defaults, and nothing paused, when nothing is stored', async () => {
    const read = await settings.read();

    expect(read.concurrency).toEqual({
      'library-scan': 1,
      'file-ingest': 4,
      'document-process': 2,
      maintenance: 1,
    });
    expect(read.unitConcurrency).toBe(1);
    expect(read.paused).toEqual([]);
  });

  it('stores what was sent and reads it back over the defaults', async () => {
    const written = await settings.write({
      concurrency: { 'file-ingest': 8, 'document-process': 3 },
      unitConcurrency: 4,
      paused: ['document-process'],
    });

    expect(written.paused).toEqual(['document-process']);
    const read = await settings.read();
    expect(read.concurrency['file-ingest']).toBe(8);
    // Every queue comes back, including the ones nobody overrode.
    expect(read.concurrency['library-scan']).toBe(1);
    expect(read.unitConcurrency).toBe(4);
    expect(read.paused).toEqual(['document-process']);
  });

  it('keeps only queues it serves, deduplicated and in pipeline order', async () => {
    const written = await settings.write({
      concurrency: {},
      unitConcurrency: 1,
      // A queue an earlier version had, a typo, and the same queue twice.
      paused: ['thumbnails', 'maintenance', 'document-process', 'maintenance'],
    });

    expect(written.paused).toEqual(['document-process', 'maintenance']);
  });

  it('clamps concurrency into range rather than refusing it', async () => {
    const written = await settings.write({
      concurrency: { 'file-ingest': 900, 'document-process': 0 },
      unitConcurrency: 900,
      paused: [],
    });

    expect(written.concurrency['file-ingest']).toBe(32);
    expect(written.concurrency['document-process']).toBe(1);
    expect(written.unitConcurrency).toBe(32);
  });

  it('ignores a stored shape it does not recognise instead of failing', async () => {
    // Written by a later version, or by hand: the workers must still start (docs/03 §3.3.21).
    await store.write(QUEUE_SETTINGS_KEY, {
      concurrency: { 'file-ingest': 6, 'document-process': 'plenty' },
      unitConcurrency: 'fast',
      paused: 'document-process',
      somethingNew: { nested: true },
    });

    const read = await settings.read();

    expect(read.concurrency['file-ingest']).toBe(6);
    // The unreadable ones fall back to their defaults.
    expect(read.concurrency['document-process']).toBe(2);
    expect(read.unitConcurrency).toBe(1);
    // A string is not a list of queues; nothing is paused.
    expect(read.paused).toEqual([]);
  });

  it('ignores a paused entry naming a queue this version does not have', async () => {
    await store.write(QUEUE_SETTINGS_KEY, { paused: ['thumbnails', 'file-ingest'] });

    expect((await settings.read()).paused).toEqual(['file-ingest']);
  });

  it('treats a stored value that is not an object as nothing stored', async () => {
    await store.write(QUEUE_SETTINGS_KEY, 'paused');

    const read = await settings.read();

    expect(read.concurrency['file-ingest']).toBe(4);
    expect(read.paused).toEqual([]);
  });
});
