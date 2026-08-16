// One command cuts a release (docs/13 §13.3a): verify CI is green on what is already pushed, let
// `npm version` write the version commit and the tag in one move, push them together — the tag
// starts the release workflow, which builds the image and publishes the GitHub Release with
// generated notes — and then stay at the console until that has actually happened. Nothing is
// re-run locally: the gate is the check that already ran.
//
// The command ends where a person means "released": `latest` in the registry resolving to the image
// this tag built. Everything between the push and that line is waiting, said out loud.
import { execFileSync } from 'node:child_process';

const BUMPS = ['patch', 'minor', 'major'];

// A CI run appears a beat after the push and then takes minutes to finish. Both are "not yet",
// not "no", so the command waits them out at the console instead of sending the person away to run
// it again later. The limits are impatience rather than policy — Ctrl-C is always the other answer.
const POLL_INTERVAL_MS = 15_000;
const APPEARANCE_LIMIT_MS = 2 * 60_000;
const COMPLETION_LIMIT_MS = 30 * 60_000;
// The release build is the long one: two native runners, and on a busy day a queue in front of
// them. It is also the one worth waiting through, because its end is the point of the command.
const PUBLISH_LIMIT_MS = 45 * 60_000;
// Once the run is green the tags are there; this only covers a registry catching its breath.
const REGISTRY_LIMIT_MS = 2 * 60_000;

const REGISTRY = 'ghcr.io';
// A multi-platform tag is an index; `Accept` has to name the single-image kinds too, or a registry
// is free to answer with something else than the digest the tag was published under.
const MANIFEST_TYPES = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

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
// kept short on purpose: a line that wraps cannot be rewritten in place; where the wait has
// something to report about itself, it is a function of the value last read.
async function waitFor(read, done, limitMs, what) {
  const startedAt = Date.now();
  let waited = false;
  let value = await read();
  while (!done(value) && Date.now() - startedAt < limitMs) {
    progress(
      `waiting for ${typeof what === 'function' ? what(value) : what} — ${elapsedSince(startedAt)}`,
    );
    waited = true;
    await sleep(POLL_INTERVAL_MS);
    value = await read();
  }
  // A rewritten line keeps the cursor on itself; what is printed next deserves its own line.
  if (waited && process.stdout.isTTY) process.stdout.write('\n');
  return done(value) ? value : null;
}

// What a tag resolves to right now, read from the registry itself rather than from the workflow
// that was supposed to move it. The image is public, so the pull token GHCR hands to anyone who
// asks is enough; it expires in minutes, which is why every look-up takes its own instead of
// holding one for the length of a build. A tag that is not published yet is null — the expected
// answer for most of the wait — and so is a registry that did not answer at all, with the reason
// kept aside for whichever message ends up giving up.
let registryTrouble = null;

async function registryDigest(repository, reference) {
  try {
    const auth = await fetch(
      `https://${REGISTRY}/token?service=${REGISTRY}&scope=repository:${repository}:pull`,
    );
    if (!auth.ok) {
      registryTrouble = `${REGISTRY} refused a pull token (${auth.status})`;
      return null;
    }
    const { token } = await auth.json();
    const manifest = await fetch(`https://${REGISTRY}/v2/${repository}/manifests/${reference}`, {
      method: 'HEAD',
      headers: { authorization: `Bearer ${token}`, accept: MANIFEST_TYPES },
    });
    registryTrouble = null;
    if (manifest.status === 404) return null;
    if (!manifest.ok) {
      registryTrouble = `${REGISTRY} answered ${manifest.status} for ${reference}`;
      return null;
    }
    return manifest.headers.get('docker-content-digest');
  } catch (error) {
    registryTrouble = `${REGISTRY} is unreachable: ${error.message}`;
    return null;
  }
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
console.log(`release: ${version} is pushed — the tag is what the image is built from`);

// The push is the point of no return; everything below only watches. Ctrl-C from here costs the
// report, not the release — the tag is out and CI finishes it either way.
const repository = run('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.full_name']).toLowerCase();
// `metadata-action` tags the image `{{version}}` — the semver without the tag's leading `v`.
const imageTag = version.replace(/^v/, '');
const tagged = run('git', ['rev-parse', 'HEAD']);

// The one push carries the version commit and the tag both, so GitHub starts two release runs on
// the same commit — and only the tag's run publishes `X.Y.Z` and moves `latest`; `main`'s run tags
// the branch and stops there. `head_branch` is the ref that started the run, which tells them apart.
const releaseRun = () => {
  const entries = JSON.parse(
    run('gh', [
      'api',
      `repos/{owner}/{repo}/actions/workflows/release.yml/runs?event=push&head_sha=${tagged}`,
      '--jq',
      '.workflow_runs | map({id, head_branch, status, html_url})',
    ]),
  );
  const found = entries.find((entry) => entry.head_branch === version);
  if (found === undefined) return null;
  // The jobs are what the wait has to say for itself, and afterwards what a red run is asked about:
  // the run's own conclusion says "failure" where the names say which half of the release failed.
  return {
    ...found,
    jobs: JSON.parse(
      run('gh', [
        'api',
        `repos/{owner}/{repo}/actions/runs/${found.id}/jobs`,
        '--jq',
        '.jobs | map({name, status, conclusion})',
      ]),
    ),
  };
};

// Short by necessity: this goes into the line that rewrites itself, and it must not wrap.
const jobsDone = (state) =>
  state === null || state.jobs.length === 0
    ? 'queued'
    : `${state.jobs.filter((job) => job.status === 'completed').length}/${state.jobs.length} jobs`;

const appeared = await waitFor(
  releaseRun,
  (found) => found !== null,
  APPEARANCE_LIMIT_MS,
  `the release run for ${version} to appear`,
);
if (appeared === null) {
  fail(
    `no release run appeared for ${version} — the tag is pushed: gh run list --workflow Release`,
  );
}
console.log(`release: the image is being built: ${appeared.html_url}`);

const built = await waitFor(
  releaseRun,
  (found) => found !== null && found.status === 'completed',
  PUBLISH_LIMIT_MS,
  (found) => `the image — ${jobsDone(found)}`,
);
if (built === null) {
  const minutes = PUBLISH_LIMIT_MS / 60_000;
  fail(
    `the release run has not finished in ${minutes} minutes: ${appeared.html_url} — the tag is ` +
      'pushed, so CI carries on without this command',
  );
}

// A red run is not one thing: a failed `build` means there is no image, a failed `scan` means the
// image is published and carries a fixable CVE. Both end the command red, and what `latest` says is
// what tells them apart — so it is read before the refusal rather than instead of it.
const broken = built.jobs.filter(
  (job) => job.conclusion !== 'success' && job.conclusion !== 'skipped',
);
if (broken.length > 0) {
  const published = await registryDigest(repository, imageTag);
  const latest = await registryDigest(repository, 'latest');
  const moved = published !== null && published === latest;
  console.error(
    `release: ${REGISTRY}/${repository}:latest ${moved ? 'does' : 'does not'} point at ${imageTag}`,
  );
  const names = broken.map((job) => job.name).join(', ');
  fail(`the release run finished red — ${names}: ${built.html_url}`);
}

// The run is green, which says the tags were created; this says they are there to be pulled, and it
// is the answer the whole command was after. The little wait is for a registry catching its breath.
const digests = await waitFor(
  async () => ({
    published: await registryDigest(repository, imageTag),
    latest: await registryDigest(repository, 'latest'),
  }),
  ({ published, latest }) => published !== null && published === latest,
  REGISTRY_LIMIT_MS,
  `${REGISTRY} to point latest at ${imageTag}`,
);
if (digests === null) {
  fail(
    `the release run is green but ${REGISTRY}/${repository}:latest does not point at ${imageTag}` +
      `${registryTrouble === null ? '' : ` — ${registryTrouble}`}: ${built.html_url}`,
  );
}

console.log(`released ${version} — ${REGISTRY}/${repository}:latest is ${digests.published}`);
if (built.jobs.some((job) => job.name === 'publish' && job.conclusion === 'success')) {
  console.log(`the notes: https://github.com/${repository}/releases/tag/${version}`);
}
