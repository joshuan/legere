import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { SpikeModule } from './spike.module';
import { SpikeService } from './spike.service';

// Proves the Vitest `server` project transpiles decorator metadata via unplugin-swc, so Nest DI
// resolves the constructor-injected GreetingService inside SpikeService (ADR-017).
describe('Nest DI under SWC (Vitest server project)', () => {
  it('resolves a constructor-injected provider by type', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpikeModule] }).compile();

    const spike = moduleRef.get(SpikeService);
    expect(spike.run()).toBe('Hello, Legere');

    await moduleRef.close();
  });
});
