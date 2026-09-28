import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Built-ins only: this command must work before node_modules exists.
const root = resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const usage = `Usage: npm run bootstrap -- [--skip-install] [--skip-docker]
  --skip-install  Reuse installed npm dependencies.
  --skip-docker   Reuse running services and an already-created S3 bucket.
  --help         Show this help.
`;

function run(command, commandArgs, label, capture = false) {
  console.log(`\n> ${label}`);
  const result = spawnSync(command, commandArgs, {
    cwd: root,
    stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`${label} failed (${result.signal ?? `exit ${result.status}`}).`);
  }
  return result.stdout?.trim();
}

function npm(...commandArgs) {
  // Keep the same Node/npm pair used to invoke bootstrap (including nvm installations).
  if (process.env.npm_execpath) {
    run(
      process.execPath,
      [process.env.npm_execpath, ...commandArgs],
      `npm ${commandArgs.join(' ')}`,
    );
  } else {
    run('npm', commandArgs, `npm ${commandArgs.join(' ')}`);
  }
}

function assertLocalDatabase() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Bootstrap is for local development; NODE_ENV must not be production.');
  }
  let database;
  try {
    database = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('Set a valid local PostgreSQL DATABASE_URL in .env.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(database.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(database.hostname)
  ) {
    throw new Error(
      'Bootstrap requires a loopback PostgreSQL DATABASE_URL (localhost/127.0.0.1/::1).',
    );
  }
}

function main() {
  for (const arg of args) {
    if (!['--skip-install', '--skip-docker', '--help'].includes(arg)) {
      throw new Error(`Unknown option: ${arg}\n${usage}`);
    }
  }
  if (args.has('--help')) {
    console.log(usage);
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 26) {
    throw new Error('Node.js 26+ is required. Run `nvm use` first.');
  }
  process.chdir(root);
  const envPath = resolve(root, '.env');
  if (!existsSync(envPath)) {
    writeFileSync(envPath, readFileSync(resolve(root, '.env.example')), {
      flag: 'wx',
      mode: 0o600,
    });
    console.log('Created .env from .env.example.');
  } else {
    console.log('Keeping existing .env.');
  }
  process.loadEnvFile(envPath);
  assertLocalDatabase();

  const compose = ['compose', '-f', resolve(root, 'docker-compose.yaml')];
  if (!args.has('--skip-docker')) {
    const version = run('docker', ['compose', 'version', '--short'], 'Check Docker Compose', true);
    const match = version?.match(/^v?(\d+)\.(\d+)/);
    if (!match || Number(match[1]) < 2 || (Number(match[1]) === 2 && Number(match[2]) < 20)) {
      throw new Error('Docker Compose 2.20+ is required for service readiness checks.');
    }
    run('docker', ['info', '--format', '{{.ServerVersion}}'], 'Check Docker engine');
  }
  mkdirSync(resolve(root, process.env.LIBRARY_ROOT || './dev-library'), { recursive: true });
  if (!args.has('--skip-install')) npm('ci');

  if (!args.has('--skip-docker')) {
    run(
      'docker',
      [
        ...compose,
        'up',
        '-d',
        '--wait',
        '--wait-timeout',
        '300',
        'db',
        'stirling',
        'docling',
        'ollama',
        'minio',
        'mailpit',
      ],
      'Start local services and wait for readiness',
    );
    // The one-shot is separate: `up --wait` expects long-running services.
    run(
      'docker',
      [...compose, 'run', '--rm', '--no-deps', 'createbuckets'],
      'Initialize MinIO bucket',
    );
  }
  npm('run', 'db:generate');
  npm('run', 'db:migrate');
  npm('run', 'queue:migrate');
  npm('run', 'db:seed');

  console.log('\nLocal development is ready. Start the app with `npm run dev`.');
  console.log(`App: ${process.env.APP_BASE_URL || 'http://localhost:3000'}`);
  console.log('Mailpit inbox (bundled Docker service): http://localhost:8025');
  console.log(
    'Dev accounts, if newly created: admin@legere.local / user@legere.local; password: password',
  );
}

try {
  main();
} catch (error) {
  console.error(`\nBootstrap stopped: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
