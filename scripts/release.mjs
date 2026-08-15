// One command cuts a release (docs/13 §13.3a): verify CI is green on what is already pushed, let
// `npm version` write the version commit and the tag in one move, and push them together — the tag
// starts the release workflow, which builds the image and publishes the GitHub Release with
// generated notes. Nothing is re-run locally: the gate is the check that already ran.
import { execFileSync } from 'node:child_process';

const BUMPS = ['patch', 'minor', 'major'];

// A CI run appears a beat after the push and then takes minutes to finish. Both are "not yet",
// not "no", so the command waits them out at the console instead of sending the person away to run
// it again later. The limits are impatience rather than policy — Ctrl-C is always the other answer.
const POLL_INTERVAL_MS = 15_000;
const APPEARANCE_LIMIT_MS = 2 * 60_000;
const COMPLETION_LIMIT_MS = 30 * 60_000;

function run(command, args, options = {}) {
  const output = execFileSync(command, args, { encoding: 'utf8', ...options });
  // With `stdio: 'inherit'` there is nothing captured to return.
  return typeof output === 'string' ? output.trim() : '';
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One line that rewrites itself on a terminal — back to the start, then erase whatever a longer
// previous line left — and plain lines where a carriage return means nothing: a log, a pipe.
function progress(message) {
  if (process.stdout.isTTY) process.stdout.write(`\rrelease: ${message}\u001b[K`);
  else console.log(`release: ${message}`);
}

function elapsedSince(startedAt) {
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

// Polls `read` until `done` holds, keeping the console posted on how long the wait has been going.
// Returns null when the limit runs out — what that silence means is the caller's to say. `what` is
// kept short on purpose: a line that wraps cannot be rewritten in place.
async function waitFor(read, done, limitMs, what) {
  const startedAt = Date.now();
  let waited = false;
  let value = read();
  while (!done(value) && Date.now() - startedAt < limitMs) {
    progress(`waiting for ${what} — ${elapsedSince(startedAt)}`);
    waited = true;
    await sleep(POLL_INTERVAL_MS);
    value = read();
  }
  // A rewritten line keeps the cursor on itself; what is printed next deserves its own line.
  if (waited && process.stdout.isTTY) process.stdout.write('\n');
  return done(value) ? value : null;
}

const bump = process.argv[2] ?? 'minor';
if (!BUMPS.includes(bump)) fail(`the bump must be one of ${BUMPS.join(', ')}, not "${bump}"`);

// The release is cut from main and only from main, with nothing half-done in the tree.
if (run('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('not on main');
if (run('git', ['status', '--porcelain']) !== '') fail('the working tree is not clean');

// What is released must be exactly what CI looked at: local main and origin/main are one commit.
run('git', ['fetch', 'origin', 'main']);
const head = run('git', ['rev-parse', 'HEAD']);
if (head !== run('git', ['rev-parse', 'origin/main'])) {
  fail('local main and origin/main differ — push (or pull) first, and let CI answer');
}

// The gate: the CI workflow ran on this very commit and came back green. A red run names itself; a
// run still going is waited on right here, because the answer is coming and the command wants it.
const ciRuns = () =>
  JSON.parse(
    run('gh', [
      'api',
      `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${head}`,
      '--jq',
      '.workflow_runs | map({status, conclusion, html_url})',
    ]),
  );

const started = await waitFor(
  ciRuns,
  (entries) => entries.length > 0,
  APPEARANCE_LIMIT_MS,
  `a CI run on ${head.slice(0, 7)} to appear`,
);
if (started === null) fail(`no CI run appeared for ${head} — is the push the workflow's trigger?`);

// The URL is said once, in a line of its own: the countdown below rewrites itself and has to fit.
const pending = started.find((entry) => entry.status !== 'completed');
if (pending !== undefined) console.log(`release: CI is still running: ${pending.html_url}`);

const runs = await waitFor(
  ciRuns,
  (entries) => entries.every((entry) => entry.status === 'completed'),
  COMPLETION_LIMIT_MS,
  'CI to finish',
);
if (runs === null) {
  const minutes = COMPLETION_LIMIT_MS / 60_000;
  fail(`CI has not finished for ${head} in ${minutes} minutes: ${pending.html_url}`);
}

const red = runs.find((entry) => entry.conclusion !== 'success');
if (red !== undefined) fail(`CI is not green for ${head}: ${red.html_url}`);

// The version commit and the tag are one move (`npm version`), pushed as one — so the tag always
// points at the commit that says the same number, and the GitHub Release follows from the tag.
const version = run('npm', ['version', bump, '-m', 'chore(release): %s']);
run('git', ['push', '--follow-tags', 'origin', 'main'], { stdio: 'inherit' });

console.log(`released ${version} — CI builds the image and publishes the GitHub Release`);
console.log(`watch it: gh run list --workflow Release`);
