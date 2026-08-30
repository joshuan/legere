import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// 🔒 The built artifact, exercised (docs/14 §14.1). `class-fields.test.ts` beside this file asserts
// that `.swcrc` and `tsconfig.server.json` agree on `useDefineForClassFields` — but an agreement
// between two config files says nothing about what the compiler actually emits, and the original
// service-gate failure lived exactly in that gap: vitest transpiles with swc, so every behavioural
// test ran the lowered JavaScript while production ran tsc's. Here the *real* `tsc` compiles the
// shape that shipped broken — a field initializer reading a constructor parameter property, next to
// a legacy-decorated member, the `ServiceGates` shape in miniature — under the emit options
// `tsconfig.server.json` resolves to, and the emitted JavaScript is evaluated. Flip the option, or
// delete it so the ES2023 default flips it silently, and this fails on behaviour, not on prose.

// The repository root, from where vitest runs: `import.meta` is not available under the CommonJS
// output the server project is type-checked against — the same reason the neighbouring test
// resolves its tree this way.
const ROOT = process.cwd();

// The exact shape of the failure (docs/14 §14.1): `this.clock` is a parameter property, assigned in
// the constructor body, and the field initializer reads it. Under `useDefineForClassFields: false`
// tsc lowers the field to a constructor assignment placed after that one; under `true` it emits a
// native field, which initializes *before* the constructor body — so the map captures `undefined`
// and the first caller that reaches for the clock finds nobody holding it.
const FIXTURE = `
function noop(_target: object, _key: string, descriptor: PropertyDescriptor): PropertyDescriptor {
  return descriptor;
}

class Gates {
  constructor(private readonly clock: () => number) {}

  private readonly gates = new Map<string, () => number>([['stirling', this.clock]]);

  @noop
  read(): number | undefined {
    return this.gates.get('stirling')?.();
  }
}

export const observed = new Gates(() => 42).read();
`;

// What `tsconfig.server.json` actually resolves to, `extends` chain included — the target lives in
// the base file, and the target is what decides the default this repository refuses to rely on.
function serverCompilerOptions(): ts.CompilerOptions {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    join(ROOT, 'tsconfig.server.json'),
    undefined,
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
    },
  );
  if (parsed === undefined) throw new Error('tsconfig.server.json did not parse');
  return parsed.options;
}

// The emit options that decide field semantics, taken from the build config rather than restated
// here — restated, they would pass whatever the build does. Spread conditionally because an absent
// option must stay absent: that is precisely the deletion whose silent ES2023 default this guards.
function emitOptions(): ts.CompilerOptions {
  const options = serverCompilerOptions();
  return {
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.useDefineForClassFields === undefined
      ? {}
      : { useDefineForClassFields: options.useDefineForClassFields }),
    ...(options.experimentalDecorators === undefined
      ? {}
      : { experimentalDecorators: options.experimentalDecorators }),
  };
}

// The real compiler, in process: no type-checking, no filesystem output — just the emit, which is
// the only thing under test.
function emitOf(options: ts.CompilerOptions): string {
  return ts.transpileModule(FIXTURE, {
    compilerOptions: { ...options, module: ts.ModuleKind.CommonJS },
    fileName: 'service-gate-fixture.ts',
  }).outputText;
}

// The emitted CommonJS, run: the fixture exports what the constructed class read back out of its
// own field, and that value is the whole verdict.
function evaluated(js: string): unknown {
  const exportsObject: Record<string, unknown> = {};
  vm.runInNewContext(js, { exports: exportsObject });
  return exportsObject['observed'];
}

describe('class fields in the built artifact', () => {
  it('lets a field initializer read a constructor parameter property, under the build options', () => {
    const emitted = emitOf(emitOptions());

    // The gate takes an actual clock: what production exercises the moment an operator sets a gate
    // to one call at a time and a caller has to wait (docs/14 §14.1, docs/05 §5.4b).
    expect(evaluated(emitted)).toBe(42);

    // And the way it holds is assignment semantics: the field is a constructor assignment placed
    // after the parameter property, not a native field that runs before it.
    expect(emitted).toContain('this.gates = ');
    expect(emitted.indexOf('this.clock = clock')).toBeLessThan(emitted.indexOf('this.gates = '));
  });

  it('is exactly the behaviour that flipping the option loses', () => {
    // The counterfactual, so the assertion above cannot rot into one that passes either way: the
    // same fixture through the same compiler with the option flipped captures `undefined`, which is
    // what shipped once and took the `canonical` step of 318 documents with it (docs/14 §14.1).
    const emitted = emitOf({ ...emitOptions(), useDefineForClassFields: true });

    expect(evaluated(emitted)).toBeUndefined();
  });
});
