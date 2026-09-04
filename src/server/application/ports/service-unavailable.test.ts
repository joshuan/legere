import { describe, expect, it } from 'vitest';
import {
  MAX_RETRY_AFTER_MS,
  ServiceThrottledError,
  ServiceUnavailableError,
  parseRetryAfter,
  throttledOrUnavailable,
} from './service-unavailable';

const NOW = new Date('2026-09-05T12:00:00.000Z');

describe('Retry-After', () => {
  it('parses delta-seconds into an absolute deadline', () => {
    expect(parseRetryAfter('90', NOW)).toEqual(new Date('2026-09-05T12:01:30.000Z'));
  });

  it('parses an HTTP date into the same absolute deadline', () => {
    expect(parseRetryAfter('Sat, 05 Sep 2026 12:01:30 GMT', NOW)).toEqual(
      new Date('2026-09-05T12:01:30.000Z'),
    );
  });

  it.each([
    ['missing', null],
    ['empty', '  '],
    ['malformed', 'when the moon is high'],
    ['negative', '-4'],
    ['fractional', '1.5'],
    ['expired date', 'Sat, 05 Sep 2026 11:59:59 GMT'],
    ['zero seconds', '0'],
    ['beyond the queue expiry', String(MAX_RETRY_AFTER_MS / 1000 + 1)],
  ])('refuses a %s value', (_name, value) => {
    expect(parseRetryAfter(value, NOW)).toBeNull();
  });

  it('preserves a valid deadline in the typed throttling error', () => {
    const error = throttledOrUnavailable('classifier', '60', NOW);

    expect(error).toBeInstanceOf(ServiceThrottledError);
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({
      service: 'classifier',
      retryAfter: new Date('2026-09-05T12:01:00.000Z'),
    });
  });

  it('falls back to ordinary typed unavailability without a usable deadline', () => {
    const error = throttledOrUnavailable('embeddings', null, NOW);

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).not.toBeInstanceOf(ServiceThrottledError);
  });
});
