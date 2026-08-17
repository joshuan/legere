import { beforeEach, describe, expect, it } from 'vitest';
import { InMemorySettingsRepository } from '../../../../test/helpers/processing-fakes';
import {
  QUEUE_SETTINGS_KEY,
  QueueSettings,
  ungatedServices,
  type QueueDefaults,
} from './queue-settings';

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
    // What `SERVICE_CONCURRENCY_*` / `SERVICE_COOLDOWN_*` resolve to on an instance where nobody
    // set them, except for the one service this environment does gate (docs/12 §12.4).
    services: { ...ungatedServices(), stirling: { concurrency: 2, cooldownSeconds: 5 } },
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
    // Every gated service is answered for, with what the environment resolved to (docs/05 §5.4b).
    expect(read.services).toEqual({
      stirling: { concurrency: 2, cooldownSeconds: 5 },
      docling: { concurrency: 0, cooldownSeconds: 0 },
      classifier: { concurrency: 0, cooldownSeconds: 0 },
      transcriber: { concurrency: 0, cooldownSeconds: 0 },
      embeddings: { concurrency: 0, cooldownSeconds: 0 },
    });
  });

  it('stores what was sent and reads it back over the defaults', async () => {
    const written = await settings.write({
      concurrency: { 'file-ingest': 8, 'document-process': 3 },
      unitConcurrency: 4,
      paused: ['document-process'],
      pausedSteps: [],
      services: { docling: { concurrency: 1, cooldownSeconds: 60 } },
    });

    expect(written.paused).toEqual(['document-process']);
    const read = await settings.read();
    expect(read.concurrency['file-ingest']).toBe(8);
    // Every queue comes back, including the ones nobody overrode.
    expect(read.concurrency['library-scan']).toBe(1);
    expect(read.unitConcurrency).toBe(4);
    expect(read.paused).toEqual(['document-process']);
    // 🔒 A stored gate wins over the environment, and a service nobody overrode keeps the env
    // value — the rule the concurrencies follow (docs/03 §3.3.21, docs/05 §5.4b).
    expect(read.services.docling).toEqual({ concurrency: 1, cooldownSeconds: 60 });
    expect(read.services.stirling).toEqual({ concurrency: 2, cooldownSeconds: 5 });
  });

  it('clamps a gate into range and drops a service it does not know', async () => {
    const written = await settings.write({
      concurrency: {},
      unitConcurrency: 1,
      paused: [],
      pausedSteps: [],
      services: {
        // Past both bounds, and below them.
        docling: { concurrency: 900, cooldownSeconds: 9000 },
        classifier: { concurrency: -4, cooldownSeconds: -1 },
        // A service this version does not gate: dropped rather than stored for ever
        // (docs/05 §5.4b).
        ocr: { concurrency: 3, cooldownSeconds: 10 },
      },
    });

    expect(written.services.docling).toEqual({ concurrency: 32, cooldownSeconds: 600 });
    // 🔒 Zero is a value, not a floor to be lifted: it is what "no gate at all" is written as.
    expect(written.services.classifier).toEqual({ concurrency: 0, cooldownSeconds: 0 });
    expect(Object.keys(written.services).sort()).toEqual([
      'classifier',
      'docling',
      'embeddings',
      'stirling',
      'transcriber',
    ]);
  });

  it('ignores a stored gate it cannot read and falls back to the environment', async () => {
    await store.write(QUEUE_SETTINGS_KEY, {
      services: {
        stirling: { concurrency: 'lots', cooldownSeconds: 30 },
        docling: 'gated',
        classifier: { concurrency: 4 },
      },
    });

    const read = await settings.read();

    // Half a gate is read as half a gate: the unreadable knob falls back, the other one stands.
    expect(read.services.stirling).toEqual({ concurrency: 2, cooldownSeconds: 30 });
    expect(read.services.docling).toEqual({ concurrency: 0, cooldownSeconds: 0 });
    expect(read.services.classifier).toEqual({ concurrency: 4, cooldownSeconds: 0 });
  });

  it('keeps only queues it serves, deduplicated and in pipeline order', async () => {
    const written = await settings.write({
      concurrency: {},
      unitConcurrency: 1,
      // A queue an earlier version had, a typo, and the same queue twice.
      paused: ['thumbnails', 'maintenance', 'document-process', 'maintenance'],
      pausedSteps: [],
      services: {},
    });

    expect(written.paused).toEqual(['document-process', 'maintenance']);
  });

  it('clamps concurrency into range rather than refusing it', async () => {
    const written = await settings.write({
      concurrency: { 'file-ingest': 900, 'document-process': 0 },
      unitConcurrency: 900,
      paused: [],
      pausedSteps: [],
      services: {},
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

  // The steps of the pipeline, held one at a time (docs/05 §5.4d).
  describe('paused steps', () => {
    it('holds nothing until somebody says otherwise', async () => {
      expect((await settings.read()).pausedSteps).toEqual([]);
      expect([...(await settings.heldSteps())]).toEqual([]);
    });

    it('keeps only the steps it runs, deduplicated and in pipeline order', async () => {
      const written = await settings.write({
        concurrency: {},
        unitConcurrency: 1,
        paused: [],
        // A step an earlier version had, a typo, the same step twice, and two real ones out of
        // order: a setting that holds nothing must not be able to sit in a database looking as
        // though it did.
        pausedSteps: ['thumbnails', 'analysis', 'canonical', 'analysis'],
        services: {},
      });

      expect(written.pausedSteps).toEqual(['canonical', 'analysis']);
      expect((await settings.read()).pausedSteps).toEqual(['canonical', 'analysis']);
      expect([...(await settings.heldSteps())]).toEqual(['canonical', 'analysis']);
    });

    it('ignores a stored list it cannot read rather than holding the pipeline', async () => {
      await store.write(QUEUE_SETTINGS_KEY, { pausedSteps: 'analysis' });

      expect((await settings.read()).pausedSteps).toEqual([]);
      expect([...(await settings.heldSteps())]).toEqual([]);
    });
  });
});
