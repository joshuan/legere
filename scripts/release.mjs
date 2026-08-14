// One command cuts a release (docs/13 §13.3a): verify CI is green on what is already pushed, let
// `npm version` write the version commit and the tag in one move, and push them together — the tag
// starts the release workflow, which builds the image and publishes the GitHub Release with
// generated notes. Nothing is re-run locally: the gate is the check that already ran.
import { execFileSync } from 'node:child_process';

const BUMPS = ['patch', 'minor', 'major'];

function run(command, args, options = {}) {
  const output = execFileSync(command, args, { encoding: 'utf8', ...options });
  // With `stdio: 'inherit'` there is nothing captured to return.
  return typeof output === 'string' ? output.trim() : '';
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
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

// The gate: the CI workflow already ran on this very commit and came back green. A red run names
// itself; a run still going asks for patience, not for a local rerun.
const runsJson = run('gh', [
  'api',
  `repos/{owner}/{repo}/actions/workflows/ci.yml/runs?head_sha=${head}`,
  '--jq',
  '.workflow_runs | map({status, conclusion, html_url})',
]);
const runs = JSON.parse(runsJson);
if (runs.length === 0) fail(`no CI run exists for ${head} — was it pushed just now? Wait for one`);
const unfinished = runs.find((entry) => entry.status !== 'completed');
if (unfinished !== undefined) fail(`CI is still running for ${head}: ${unfinished.html_url}`);
const red = runs.find((entry) => entry.conclusion !== 'success');
if (red !== undefined) fail(`CI is not green for ${head}: ${red.html_url}`);

// The version commit and the tag are one move (`npm version`), pushed as one — so the tag always
// points at the commit that says the same number, and the GitHub Release follows from the tag.
const version = run('npm', ['version', bump, '-m', 'chore(release): %s']);
run('git', ['push', '--follow-tags', 'origin', 'main'], { stdio: 'inherit' });

console.log(`released ${version} — CI builds the image and publishes the GitHub Release`);
console.log(`watch it: gh run list --workflow Release`);
