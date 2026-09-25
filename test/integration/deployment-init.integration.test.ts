import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('deploy/init.sh');
const fixtures = resolve('deploy');
const directories: string[] = [];
const composeAvailable = spawnSync('docker', ['compose', 'version']).status === 0;

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup(): Promise<{ directory: string; bin: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'legere-init-test-'));
  directories.push(directory);
  const bin = join(directory, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(
    join(bin, 'curl'),
    '#!/bin/sh\n[ "${FAIL_DOWNLOAD:-}" != "${2##*/}" ] || exit 1\ncp "$FIXTURES/${2##*/}" "$4"\n',
    { mode: 0o700 },
  );
  return { directory, bin };
}

function initialize(directory: string, bin: string, env: Record<string, string> = {}) {
  return spawnSync('bash', [script], {
    cwd: directory,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FIXTURES: fixtures,
      LEGERE_HOST: 'localhost',
      LEGERE_PORT: '3000',
      SMTP_HOST: '',
      ...env,
    },
  });
}

describe('deployment initializer', () => {
  it('creates traversable library directories, private secrets and no leftover staging files', async () => {
    const { directory, bin } = await setup();
    const result = initialize(directory, bin, { LIBRARY_PATH: 'new-parent/documents' });
    expect(result.status, result.stderr).toBe(0);
    expect((await stat(join(directory, '.env'))).mode & 0o777).toBe(0o600);
    expect((await stat(join(directory, 'new-parent'))).mode & 0o777).toBe(0o755);
    expect((await stat(join(directory, 'new-parent/documents'))).mode & 0o777).toBe(0o755);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    const env = await readFile(join(directory, '.env'), 'utf8');
    expect(env).toMatch(/^AUTH_SECRET="[a-f0-9]{48}"$/m);
    expect(env).toMatch(/^MINIO_APP_PASSWORD="[a-f0-9]{40}"$/m);
    expect((await readdir(directory)).some((name) => name.startsWith('.legere-init.'))).toBe(false);
  });

  it('leaves no partial deployment when a download fails', async () => {
    const { directory, bin } = await setup();
    const result = initialize(directory, bin, { FAIL_DOWNLOAD: '.env.example' });
    expect(result.status).not.toBe(0);
    expect(await readdir(directory)).toEqual(
      expect.not.arrayContaining(['.env', 'docker-compose.yaml']),
    );
    expect((await readdir(directory)).some((name) => name.startsWith('.legere-init.'))).toBe(false);
  });

  it.each(['.env', 'docker-compose.yaml'])('preserves an existing %s', async (name) => {
    const { directory, bin } = await setup();
    await writeFile(join(directory, name), 'existing deployment\n');
    const result = initialize(directory, bin);
    expect(result.status).not.toBe(0);
    expect(await readFile(join(directory, name), 'utf8')).toBe('existing deployment\n');
  });

  it.skipIf(!composeAvailable)(
    'preserves special characters through real Compose interpolation',
    async () => {
      const { directory, bin } = await setup();
      const library = join(directory, 'files & notes | $ARCHIVE \\ "quoted"');
      const password = 'pa$$word ${UNSET} # spaces \\ "double" \'single\' trailing\\';
      const from = 'Archive "receipts" <mail@example.com>';
      const result = initialize(directory, bin, {
        LIBRARY_PATH: library,
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_USER: 'user@example.com',
        SMTP_PASSWORD: password,
        SMTP_FROM: from,
      });
      expect(result.status, result.stderr).toBe(0);
      const rendered = spawnSync('docker', ['compose', 'config', '--format', 'json'], {
        cwd: directory,
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH, NODE_ENV: 'test' },
      });
      expect(rendered.status, rendered.stderr).toBe(0);
      const config: unknown = JSON.parse(rendered.stdout);
      expect(config).toMatchObject({
        services: {
          app: {
            environment: {
              // `compose config` escapes dollars again so its output is a reusable Compose file.
              SMTP_PASSWORD: password.replaceAll('$', () => '$$'),
              SMTP_USER: 'user@example.com',
              SMTP_PORT: '587',
              SMTP_SECURE: 'false',
              SMTP_FROM: from,
            },
            volumes: [
              { source: library.replaceAll('$', () => '$$'), target: '/library', read_only: true },
            ],
          },
        },
      });
    },
  );
});
