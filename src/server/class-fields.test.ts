import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

// 🔒 What the tests run and what ships have to be the same JavaScript (docs/14 §14.1). They were not:
// `.swcrc` — the transform behind both the test runner and the dev server — lowers class fields to
// assignments in the constructor, while `tsc` at `target: ES2023` emits native fields, which
// initialize *before* the constructor body. A field initializer reading a constructor parameter
// property therefore worked in every test and was `undefined` in production, where it took out the
// `canonical` step of 318 documents.
//
// Behaviour cannot catch this: under the test transform the broken code behaves. So the agreement
// itself is asserted, on the two files that carry it.

// The repository root, from where vitest runs: `import.meta` is not available under the CommonJS
// output the server project is type-checked against — the same reason the loading-boundary test
// resolves its tree this way.
const ROOT = process.cwd();

// Both files carry line comments, which `JSON.parse` will not take; they are stripped rather than a
// dependency pulled in for two reads. Zod does the narrowing, since assertions are forbidden — and
// it is handed `unknown`, because `JSON.parse` answers `any` and an `any` returned is an `any` that
// spreads (docs/14 §14.1).
function classFieldSetting(
  file: string,
  schema: z.ZodType<boolean, z.ZodTypeDef, unknown>,
): boolean {
  const raw: unknown = JSON.parse(
    readFileSync(join(ROOT, file), 'utf8').replace(/^\s*\/\/.*$/gm, ''),
  );
  return schema.parse(raw);
}

// Each schema reaches for the one field that matters and answers with it.
const swcrcSetting = z
  .object({ jsc: z.object({ transform: z.object({ useDefineForClassFields: z.boolean() }) }) })
  .transform((swcrc) => swcrc.jsc.transform.useDefineForClassFields);

const tsconfigSetting = z
  .object({ compilerOptions: z.object({ useDefineForClassFields: z.boolean() }) })
  .transform((tsconfig) => tsconfig.compilerOptions.useDefineForClassFields);

describe('class fields', () => {
  it('are emitted the same way by the build and by the test transform', () => {
    const tests = classFieldSetting('.swcrc', swcrcSetting);
    const build = classFieldSetting('tsconfig.server.json', tsconfigSetting);

    // Explicit on both sides: a default that changes with the target is a default that changes under
    // somebody who is not looking at it.
    expect(build).toBe(false);
    expect(tests).toBe(build);
  });
});
