import { describe, expect, it } from 'vitest';
import { formatBytes } from './format-bytes';

describe('formatBytes', () => {
  it('leaves small counts in whole bytes', () => {
    expect(formatBytes('0')).toBe('0 B');
    expect(formatBytes('1023')).toBe('1023 B');
  });

  it('scales to the unit a human reads, rounded to a tenth', () => {
    expect(formatBytes('1024')).toBe('1.0 KB');
    expect(formatBytes('1932735283')).toBe('1.8 GB');
    expect(formatBytes('1610612736')).toBe('1.5 GB');
  });

  it('carries a rounded tenth instead of printing 1.10', () => {
    // 1 GB minus a hair: 1023.99 MB rounds up to a whole gigabyte.
    expect(formatBytes('1073731824')).toBe('1.0 GB');
  });

  it('counts past what a JS number holds exactly', () => {
    // 9 PB in bytes, well beyond Number.MAX_SAFE_INTEGER.
    expect(formatBytes('10133099161583616')).toBe('9.0 PB');
  });

  it('passes anything that is not a byte count straight through', () => {
    expect(formatBytes('unknown')).toBe('unknown');
  });
});
