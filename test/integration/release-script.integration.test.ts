import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/release.mjs');
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function release(scenario: string) {
  const directory = await mkdtemp(join(tmpdir(), 'legere-release-test-'));
  directories.push(directory);
  const calls = join(directory, 'calls.jsonl');
  const fixture = `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs');
const { basename } = require('node:path');
const tool = basename(process.argv[1]);
const args = process.argv.slice(2);
appendFileSync(process.env.CALLS, JSON.stringify({ tool, args }) + '\\n');
const scenario = process.env.SCENARIO;
const countFile = process.env.CALLS + '.ci';
const count = existsSync(countFile) ? Number(readFileSync(countFile, 'utf8')) : 0;
const emit = (value) => console.log(typeof value === 'string' ? value : JSON.stringify(value));
if (tool === 'git') {
  if (args[0] === 'rev-parse') emit(args.includes('--abbrev-ref') ? 'main' : 'abc123');
  else if (args[0] === 'status' && scenario === 'changed-checkout' && count > 0) emit(' M README.md');
} else if (tool === 'npm') {
  emit('v1.2.3');
} else if (args[1].includes('ci.yml')) {
  writeFileSync(countFile, String(count + 1));
  const entry = { status: 'completed', conclusion: 'success', html_url: 'https://example.test/ci' };
  if (scenario === 'red-ci') entry.conclusion = 'failure';
  if (scenario === 'missing-ci' && count > 0) emit([]);
  else emit([entry]);
} else if (args[1].includes('release.yml')) {
  emit([{ id: 1, head_branch: 'v1.2.3', status: 'completed', conclusion: scenario === 'cancelled' ? 'cancelled' : 'success', html_url: 'https://example.test/release' }]);
} else if (args[1].endsWith('/jobs')) {
  emit([{ name: 'publish', status: 'completed', conclusion: scenario === 'cancelled' ? 'skipped' : 'success' }]);
} else {
  emit('example/legere');
}
`;
  await Promise.all(
    ['git', 'npm', 'gh'].map((name) => writeFile(join(directory, name), fixture, { mode: 0o700 })),
  );
  const preload = join(directory, 'preload.mjs');
  await writeFile(
    preload,
    `let now = 0;
Date.now = () => { now += 1800000; return now; };
globalThis.setTimeout = (callback) => { callback(); return 0; };
globalThis.fetch = async (url) => url.includes('/token?')
  ? Response.json({ token: 'fixture' })
  : new Response(null, { headers: { 'docker-content-digest': 'sha256:fixture' } });
`,
  );
  const result = spawnSync(process.execPath, ['--import', preload, script, 'patch'], {
    encoding: 'utf8',
    timeout: 10_000,
    cwd: directory,
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      CALLS: calls,
      SCENARIO: scenario,
    },
  });
  const commands = (await readFile(calls, 'utf8'))
    .trim()
    .split('\n')
    .map((line): unknown => JSON.parse(line));
  return { ...result, commands };
}

describe('release command safeguards', () => {
  it('pushes only main and the new tag in one atomic update', async () => {
    const result = await release('green');
    expect(result.status, result.stderr).toBe(0);
    expect(result.commands).toContainEqual({
      tool: 'git',
      args: ['push', '--atomic', 'origin', 'refs/heads/main:refs/heads/main', 'refs/tags/v1.2.3'],
    });
    expect(result.stdout).toContain('released v1.2.3');
  });

  it.each(['red-ci', 'missing-ci', 'changed-checkout'])(
    'does not create a version or push when %s invalidates the gate',
    async (scenario) => {
      const result = await release(scenario);
      expect(result.status).not.toBe(0);
      expect(result.commands).not.toContainEqual(expect.objectContaining({ tool: 'npm' }));
      const pushArguments: unknown = expect.arrayContaining(['push']);
      expect(result.commands).not.toContainEqual({
        tool: 'git',
        args: pushArguments,
      });
    },
  );

  it('reports a cancelled workflow even if all listed jobs were skipped', async () => {
    const result = await release('cancelled');
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the release run finished red — cancelled');
    expect(result.stdout).not.toContain('released v1.2.3');
  });
});
