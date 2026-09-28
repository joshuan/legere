import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture(existingEnv?: string) {
  const directory = await mkdtemp(join(tmpdir(), 'legere-bootstrap-test-'));
  directories.push(directory);
  await mkdir(join(directory, 'scripts'));
  const bin = join(directory, 'bin');
  await mkdir(bin);
  const runner = join(directory, 'scripts/bootstrap.mjs');
  await writeFile(runner, await readFile('scripts/bootstrap.mjs'));
  const example = await readFile('.env.example', 'utf8');
  await writeFile(join(directory, '.env.example'), example);
  await writeFile(join(directory, 'docker-compose.yaml'), 'services: {}\n');
  if (existingEnv !== undefined) await writeFile(join(directory, '.env'), existingEnv);

  // Record subprocess boundaries, never connect to the developer's Docker or database.
  const cli = `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
const tool = basename(process.argv[1]) === 'docker' ? 'docker' : 'npm';
const args = process.argv.slice(2);
const command = [tool, ...args].join(' ');
appendFileSync('calls.txt', command + '\\n');
writeFileSync('database.txt', process.env.DATABASE_URL);
if (process.env.FAIL_STEP && command.includes(process.env.FAIL_STEP)) process.exit(42);
if (args[0] === 'compose' && args[1] === 'version') console.log('2.40.3');
`;
  await writeFile(join(bin, 'docker'), cli, { mode: 0o700 });
  await writeFile(join(bin, 'npm.mjs'), cli);
  await writeFile(join(directory, 'calls.txt'), '');
  return {
    directory,
    example,
    run(args: string[] = [], overrides: Record<string, string | undefined> = {}) {
      const env = { ...process.env };
      for (const key of ['NODE_ENV', 'DATABASE_URL', 'LIBRARY_ROOT', 'FAIL_STEP']) {
        delete env[key];
      }
      Object.assign(env, {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        npm_execpath: join(bin, 'npm.mjs'),
        ...overrides,
      });
      return spawnSync(process.execPath, [runner, ...args], {
        // Exercise root resolution even when invoked from elsewhere.
        cwd: tmpdir(),
        encoding: 'utf8',
        timeout: 10_000,
        env,
      });
    },
    async calls() {
      return (await readFile(join(directory, 'calls.txt'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean);
    },
  };
}

describe('local development bootstrap', () => {
  it('prepares a fresh checkout and waits for services and bucket before migrating and seeding', async () => {
    const app = await fixture();
    const result = app.run();
    expect(result.status, result.stderr).toBe(0);
    expect(await readFile(join(app.directory, '.env'), 'utf8')).toBe(app.example);
    expect((await stat(join(app.directory, '.env'))).mode & 0o777).toBe(0o600);
    await expect(access(join(app.directory, 'dev-library'))).resolves.toBeUndefined();
    expect(await app.calls()).toEqual([
      'docker compose version --short',
      'docker info --format {{.ServerVersion}}',
      'npm ci',
      expect.stringMatching(
        /docker compose .* up -d --wait --wait-timeout 300 db stirling docling ollama minio mailpit$/,
      ),
      expect.stringMatching(/docker compose .* run --rm --no-deps createbuckets$/),
      'npm run db:generate',
      'npm run db:migrate',
      'npm run queue:migrate',
      'npm run db:seed',
    ]);
    expect(result.stdout).toContain('npm run dev');
    expect(result.stdout).toContain('http://localhost:8025');
  });

  it.each([undefined, 'postgresql://fixture:fixture@127.0.0.1/exported_dev'])(
    'preserves .env, respects exported values and supports reusing dependencies and services: %s',
    async (database) => {
      const existing =
        '# Keep this comment\nDATABASE_URL=postgresql://fixture:fixture@localhost/local_dev\nLIBRARY_ROOT=custom-library\n';
      const app = await fixture(existing);
      const result = app.run(['--skip-install', '--skip-docker'], { DATABASE_URL: database });
      expect(result.status, result.stderr).toBe(0);
      expect(await readFile(join(app.directory, '.env'), 'utf8')).toBe(existing);
      expect(await readFile(join(app.directory, 'database.txt'), 'utf8')).toBe(
        database ?? 'postgresql://fixture:fixture@localhost/local_dev',
      );
      await expect(access(join(app.directory, 'custom-library'))).resolves.toBeUndefined();
      expect(await app.calls()).toEqual([
        'npm run db:generate',
        'npm run db:migrate',
        'npm run queue:migrate',
        'npm run db:seed',
      ]);
    },
  );

  it.each([
    'NODE_ENV=production\nDATABASE_URL=postgresql://fixture:fixture@localhost/dev\n',
    'DATABASE_URL=postgresql://fixture:private-password@remote.example/dev\n',
    'DATABASE_URL=invalid\n',
  ])('refuses unsafe or invalid database setup before invoking subprocesses', async (env) => {
    const app = await fixture(env);
    const result = app.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Bootstrap stopped:');
    expect(result.stderr).not.toContain('private-password');
    expect(await app.calls()).toEqual([]);
  });

  it.each(['npm ci', 'createbuckets', 'npm run queue:migrate'])(
    'stops immediately when %s fails',
    async (step) => {
      const app = await fixture();
      const result = app.run([], { FAIL_STEP: step });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('exit 42');
      const calls = await app.calls();
      expect(calls.at(-1)).toContain(step);
      expect(calls).not.toContain('npm run db:seed');
      expect(result.stdout).not.toContain('Local development is ready');
    },
  );

  it('offers help without creating configuration or running setup', async () => {
    const app = await fixture();
    const result = app.run(['--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('--skip-docker');
    await expect(access(join(app.directory, '.env'))).rejects.toThrow();
    expect(await app.calls()).toEqual([]);
  });
});
