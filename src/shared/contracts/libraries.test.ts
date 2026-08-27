import { describe, expect, it } from 'vitest';
import { excludeGlobsSchema } from './libraries';

describe('excludeGlobsSchema', () => {
  it('accepts the exclusions a real library uses', () => {
    const result = excludeGlobsSchema.safeParse([
      '**/node_modules/**',
      '.DS_Store',
      '**/*.tmp',
      'archive/**/drafts/*',
    ]);

    expect(result.success).toBe(true);
  });

  // 🔒 picomatch compiles a glob to a backtracking regular expression with no complexity limit, and
  // the matcher runs once per directory entry during a scan. `a*a*a*…b` against a filename of `a`s
  // does not finish, and a scan job has no CPU timeout to stop it — so the bound is on the glob.
  it('refuses a glob whose wildcards multiply', () => {
    const bomb = `${'a*'.repeat(20)}b`;

    const result = excludeGlobsSchema.safeParse([bomb]);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/pattern characters/);
  });

  it('refuses the bomb even when it hides among honest globs', () => {
    const result = excludeGlobsSchema.safeParse(['**/*.tmp', `${'b*'.repeat(12)}c`]);

    expect(result.success).toBe(false);
  });

  // 🔒 The form that sat inside the old allowance because it counted `*` and nothing else
  // (docs/05 §5.4a): `?*` eight times is exactly eight asterisks, passed, and cost 149 ms against a
  // thirty-four-character name, 2.6 s against sixty and 21 s against eighty. What drives the
  // backtracking is how many variable-length pieces the pattern has, and `?` is one of them.
  it('counts every pattern character, not only the asterisks', () => {
    expect(excludeGlobsSchema.safeParse([`${'?*'.repeat(8)}z`]).success).toBe(false);
    expect(excludeGlobsSchema.safeParse([`${'@(a|a)'.repeat(10)}z`]).success).toBe(false);
  });

  it('still bounds the length and the count', () => {
    expect(excludeGlobsSchema.safeParse(['x'.repeat(257)]).success).toBe(false);
    expect(excludeGlobsSchema.safeParse(Array.from({ length: 51 }, () => '*.tmp')).success).toBe(
      false,
    );
  });
});
