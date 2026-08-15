import { describe, expect, it } from 'vitest';
import { SERVICE_NAMES, type ServiceName } from '../../../shared/contracts/queue';
import { Clock } from '../ports/clock';
import { CheckExternalServices } from './check-external-services';
import { ExternalServiceProbe, type ServiceProbeResult } from './ports';

class FixedClock extends Clock {
  constructor(private current: Date) {
    super();
  }
  now(): Date {
    return this.current;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

// A probe that counts how often it was actually asked, so a test can tell an answer that was taken
// from one that was remembered.
class CountingProbe extends ExternalServiceProbe {
  calls = 0;
  constructor(private readonly answer: (service: ServiceName) => ServiceProbeResult) {
    super();
  }
  check(service: ServiceName): Promise<ServiceProbeResult> {
    this.calls += 1;
    return Promise.resolve(this.answer(service));
  }
}

const UP: ServiceProbeResult = {
  url: 'http://stirling:8080',
  status: 'UP',
  httpStatus: 200,
  latencyMs: 12,
  detail: null,
};

const clock = (): FixedClock => new FixedClock(new Date('2026-08-15T10:00:00.000Z'));

describe('CheckExternalServices', () => {
  it('answers for every gated service, in the order the settings list them', async () => {
    const result = await new CheckExternalServices(new CountingProbe(() => UP), clock()).execute();

    expect(result.services.map((row) => row.service)).toEqual([...SERVICE_NAMES]);
  });

  it('stamps every row with the time the probe was taken', async () => {
    const result = await new CheckExternalServices(new CountingProbe(() => UP), clock()).execute();

    expect(result.services.every((row) => row.checkedAt === '2026-08-15T10:00:00.000Z')).toBe(true);
  });

  it('carries what the probe found through untouched', async () => {
    const result = await new CheckExternalServices(
      new CountingProbe((service) =>
        service === 'docling'
          ? { url: '', status: 'NOT_CONFIGURED', httpStatus: null, latencyMs: null, detail: null }
          : UP,
      ),
      clock(),
    ).execute();

    expect(result.services.find((row) => row.service === 'docling')).toEqual({
      service: 'docling',
      checkedAt: '2026-08-15T10:00:00.000Z',
      url: '',
      status: 'NOT_CONFIGURED',
      httpStatus: null,
      latencyMs: null,
      detail: null,
    });
  });

  // 🔒 The answer to "which of my services are up" must not become an error page because one adapter
  // had a bad day — least of all during the outage that made somebody ask.
  it('reports a probe that throws as down and keeps the other four', async () => {
    class ThrowingProbe extends ExternalServiceProbe {
      check(service: ServiceName): Promise<ServiceProbeResult> {
        if (service === 'classifier') return Promise.reject(new Error('probe exploded'));
        return Promise.resolve(UP);
      }
    }

    const result = await new CheckExternalServices(new ThrowingProbe(), clock()).execute();

    const classifier = result.services.find((row) => row.service === 'classifier');
    expect(classifier?.status).toBe('DOWN');
    expect(classifier?.detail).toBe('probe exploded');
    expect(result.services.filter((row) => row.status === 'UP')).toHaveLength(4);
  });

  it('truncates a reason too long to sit in a tooltip', async () => {
    class VerboseProbe extends ExternalServiceProbe {
      check(): Promise<ServiceProbeResult> {
        return Promise.reject(new Error('x'.repeat(1000)));
      }
    }

    const result = await new CheckExternalServices(new VerboseProbe(), clock()).execute();

    expect(result.services[0]?.detail).toHaveLength(301);
    expect(result.services[0]?.detail?.endsWith('…')).toBe(true);
  });

  // Every open admin tab asks for this, and each ask leaves the instance five times.
  describe('the cost of being asked', () => {
    it('answers a second caller from what it already knows', async () => {
      const probe = new CountingProbe(() => UP);
      const check = new CheckExternalServices(probe, clock());

      await check.execute();
      await check.execute();

      expect(probe.calls).toBe(SERVICE_NAMES.length);
    });

    it('probes again once the answer has aged', async () => {
      const probe = new CountingProbe(() => UP);
      const time = clock();
      const check = new CheckExternalServices(probe, time);

      await check.execute();
      time.advance(6_000);
      await check.execute();

      expect(probe.calls).toBe(SERVICE_NAMES.length * 2);
    });

    it('costs one round of probes for a burst that arrives together', async () => {
      const probe = new CountingProbe(() => UP);
      const check = new CheckExternalServices(probe, clock());

      const results = await Promise.all(Array.from({ length: 10 }, () => check.execute()));

      expect(probe.calls).toBe(SERVICE_NAMES.length);
      expect(results.every((result) => result.services.length === SERVICE_NAMES.length)).toBe(true);
    });
  });
});
