// Dev runner (ADR-017): register the SWC ESM loader so TypeScript is transpiled with decorator
// metadata (design:paramtypes) — Nest DI depends on it. esbuild/tsx do NOT emit this metadata,
// which is why the dev/test transpiler is SWC and not esbuild. See ./swc-esm-loader.mjs for why
// the loader is hand-rolled rather than @swc-node/register.
import { register } from 'node:module';

register('./swc-esm-loader.mjs', import.meta.url);

const { bootstrap } = await import('./main.ts');
await bootstrap({ dev: true });
