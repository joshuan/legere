// Custom SWC ESM loader for the dev/test runner (ADR-017).
//
// Why hand-rolled instead of @swc-node/register: that loader always emits ESM code but declares
// the module *format* from the nearest package.json `type`. With a CommonJS-root package (which
// keeps the doc-exact NodeNext tsconfig perfect for typecheck + the CommonJS prod build), it
// declares `commonjs` for the ESM code it emitted, so Node loads ESM as CJS and trips
// ERR_REQUIRE_CYCLE_MODULE. Here we emit ESM *and* declare `format: 'module'` consistently, so
// the project stays CommonJS at the package level while `.ts` runs as ESM in dev/test.
//
// Decorator metadata (design:paramtypes) is emitted via `.swcrc`
// (jsc.transform.decoratorMetadata) — Nest DI depends on it; esbuild/tsx do not emit it.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { transformSync } from '@swc/core';

const { jsc } = JSON.parse(readFileSync(new URL('../.swcrc', import.meta.url), 'utf8'));
const TS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts'];

const hasTsExtension = (p) => TS_EXTENSIONS.some((ext) => p.endsWith(ext));

function resolveTsTarget(target) {
  if (existsSync(target) && statSync(target).isFile()) {
    return hasTsExtension(target) ? target : null;
  }
  for (const ext of TS_EXTENSIONS) {
    if (existsSync(target + ext)) return target + ext;
  }
  for (const ext of TS_EXTENSIONS) {
    const indexFile = resolvePath(target, `index${ext}`);
    if (existsSync(indexFile)) return indexFile;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  if (isRelative && context.parentURL?.startsWith('file:')) {
    const target = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    const resolved = resolveTsTarget(target);
    if (resolved) {
      return { url: pathToFileURL(resolved).href, format: 'module', shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:') && hasTsExtension(url)) {
    const filename = fileURLToPath(url);
    const { code } = transformSync(readFileSync(filename, 'utf8'), {
      jsc,
      module: { type: 'es6' },
      filename,
      sourceMaps: 'inline',
    });
    return { format: 'module', source: code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
