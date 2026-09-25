import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe('local queue migration environment', () => {
  it.each([undefined, 'postgresql://ci:fixture@localhost/ci_test'])(
    'loads .env while retaining explicit environment precedence: %s',
    async (inherited) => {
      const directory = await mkdtemp(join(tmpdir(), 'legere-queue-runner-test-'));
      directories.push(directory);
      const runner = join(directory, 'migrate-queue-runner.mjs');
      await writeFile(runner, await readFile('server/migrate-queue-runner.mjs'));
      await writeFile(
        join(directory, '.env'),
        'DATABASE_URL=postgresql://local:fixture@localhost/local_test\n',
      );
      await writeFile(join(directory, 'migrate-queue.ts'), '');
      // Replace only the imported migration body. Exercise the real executable and its .env
      // loading without allowing a subprocess to connect to any developer database.
      await writeFile(
        join(directory, 'swc-esm-loader.mjs'),
        `export async function load(url, context, nextLoad) {
  if (url.endsWith('/migrate-queue.ts')) return {
    format: 'module', shortCircuit: true,
    source: 'export async function migrateQueue() { console.log(process.env.DATABASE_URL); }'
  };
  return nextLoad(url, context);
}`,
      );
      const result = spawnSync(process.execPath, [runner], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
        env: { ...process.env, DATABASE_URL: inherited },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.trim()).toBe(
        inherited ?? 'postgresql://local:fixture@localhost/local_test',
      );
    },
  );
});
