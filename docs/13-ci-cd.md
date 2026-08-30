# 13. CI/CD (GitHub Actions)

CI validates every PR and builds the **three** images the shipped stack runs, published to **GHCR**:
the application, and the two parsers of [`12 §12.7`](./12-build-config-run.md#127-deployment-deploy-shipped-with-the-repository)
(`legere-stirling`, `legere-docling`). Deployment itself is not described here — the compose file
that runs them is.

## 13.1. Principles

- Every PR must be green: `typecheck` + `lint` + `test` + `build`. `main` is protected: PRs only,
  required status check `CI / build-and-test` (ADR-014).
- Node from `.nvmrc` (`actions/setup-node` with `node-version-file`), npm cache.
- Integration tests run against a PostgreSQL **pgvector** service container.
- External services are not needed in CI: `FileStorage`, `PdfToolbox`, `EmailSender`,
  `CaptchaVerifier`, `EmbeddingProvider`, `DocumentAnalyst` are mocked behind their ports
  ([`14 §14.8`](./14-coding-standards.md#148-testing)). Dummy env values exist only to satisfy config
  validation.
- On `main`/tags: build and push the application image. On a `v*` tag, the two parser images beside
  it — they are what `LEGERE_VERSION` names, and a branch is not a version. **No deploy job.**

### The pipeline is itself an attack surface

CI runs `npm ci` — that is, third-party lifecycle scripts — on every push to `main`, and the release
pipeline publishes the image every deployment pulls. Four rules follow, and every workflow in this
repository keeps all four (SEC-21):

- **A `permissions:` block in every workflow.** Without one the job takes the repository default,
  which may be read-write; with one, `GITHUB_TOKEN` is `contents: read` and a job that publishes asks
  for `packages: write` on itself rather than granting it to the whole file.
- **Third-party actions pinned to a commit SHA**, with the version in a trailing comment. A major tag
  is mutable: `@v4` is whatever its owner last moved it to. The comment is what a person reads and
  what Dependabot rewrites together with the SHA.
- **A dependency audit that can fail the build.** `npm audit --omit=dev --audit-level=high` runs in
  `build-and-test` *before* `npm ci`, so an advisory is reported before the packages it concerns get
  to run their install scripts. `npm audit` reads the lockfile and needs no `node_modules`.
- **An image scan on release, over every image this repository publishes.** The audit sees the
  lockfile and nothing below it; the base image is where the native libraries live — including
  libvips, whose four CVEs (SEC-07) are the reason this section exists. For a long time the rule
  reached one image of the three, and the two it missed are the ones whose base image *is* the
  native OCR/PDF stack ([`SEC-79`](./tasks/security-audit-2026-08-second-pass.md#sec-79)); they are
  built, tagged and scanned here now, and their bases are pinned by digest so that a fixed CVE in
  one of them is an edit somebody can make.

The threshold is deliberate. `--omit=dev` is what ships in the image and `high` is the severity that
warrants stopping a merge; a moderate advisory in a linter is a Dependabot pull request, not a red
`main`. The image scan reports `HIGH,CRITICAL` and skips findings with no fix available, because a
finding nobody can act on is a broken build nobody can fix.

`ignore-unfixed` sorts findings by whether *someone* has a patch, which is not the same question as
whether *we* can apply one. Release 0.7.0 failed the scan on two advisories against npm's own bundled
`brace-expansion` and `ip-address` — fixed upstream, unreachable from our lockfile, and living in a
package manager the runtime never invokes. The answer is neither an ignore file nor a wait for the
base image: the runtime stage deletes npm and corepack outright (§12.6). It is the general shape of
the fix for this class — a scanner reporting code the image does not need is telling you to remove
the code, and only a suppression list would let the finding survive as an entry nobody rereads.

The parser images later met the other class: code the image *does* need, fixed upstream, and our pin
already on upstream's newest build — nothing to delete and nowhere to move (release `v0.26.0`, the
first whose scan read all three images back). That class does take a list (§13.3), because there the
entry is the record of a decision rather than a substitute for one: each line points at its record
in [`12 §12.7`](./12-build-config-run.md#127-deployment-deploy-shipped-with-the-repository) —
which image, why the finding is not reachable in this deployment, what would make it reachable —
and the entry is deleted when the pin move that clears it lands.

### Dependabot

`.github/dependabot.yml` watches three ecosystems weekly — npm at the root, `github-actions` (which
keeps the SHA pins above from freezing), and `docker` for the three base images (`/`,
`/deploy/docling`, `/deploy/stirling`). Minor and patch updates are grouped into one pull request per
ecosystem; majors come one at a time, because those are the ones that need a person to read a
migration guide. The two parser bases are written `tag@sha256:…`, which is the form that makes this
work in both directions: the digest is what the build resolves, and the tag beside it is what
Dependabot reads to know a newer one exists — it rewrites the pair, the way it rewrites an action's
SHA and its version comment. This is the half of the answer the audit does not give: `npm audit`
says something is wrong, Dependabot arrives with the fix already written and CI green or not on it.

## 13.2. `.github/workflows/ci.yml`

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:pg16
        env: { POSTGRES_USER: legere, POSTGRES_PASSWORD: legere, POSTGRES_DB: legere_test }
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U legere -d legere_test"
          --health-interval 5s --health-timeout 5s --health-retries 10
    env:
      NODE_ENV: test
      DATABASE_URL: postgresql://legere:legere@localhost:5432/legere_test?schema=public
      APP_BASE_URL: http://localhost:3000
      AUTH_SECRET: test-secret-minimum-32-characters!!
      LIBRARY_ROOT: /tmp/test-library
      STIRLING_URL: http://localhost:8080
      S3_ENDPOINT: http://localhost:9000
      S3_REGION: us-east-1
      S3_BUCKET: test
      S3_ACCESS_KEY_ID: test
      S3_SECRET_ACCESS_KEY: test
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: ''
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm audit --omit=dev --audit-level=high   # before install: no lifecycle script has run yet
      - run: npm ci
      - run: npm run db:generate
      - run: npm run db:migrate          # apply migrations to the test DB
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test:coverage       # domain+application floor of 14 §14.8, enforced
      - run: npm run build
```

> Filesystem-dependent tests (`FsLibraryReader`, scan walker) create fixtures under
> `LIBRARY_ROOT=/tmp/test-library` — plain tmpfs, no privileges needed. An optional MinIO step
> (`docker run -d -p 9000:9000 minio/minio server /data` + bucket creation) can enable the real
> `S3FileStorage` integration suite; by default it is skipped in CI and runs locally against the dev
> compose (service containers cannot override `command`, hence a step, not a `service`).

## 13.3. `.github/workflows/release.yml`

Triggered by a push to `main` (image tags `main`, `sha-…`) and by a `v*` tag. The tag is cut locally
by `npm run release` (§13.3a) — one push carrying the version commit and the tag together — and CI
answers it with the image and then the GitHub Release, in that order, so a release that exists always
names an image that exists.

The image is **multi-platform** (`linux/amd64`, `linux/arm64`): the quickstart of the root
`README.md` is a `docker compose up`, and self-hosters run it on Apple Silicon and ARM servers as
readily as on x86. Each platform builds on a runner of its own architecture and pushes an untagged
manifest **by digest**; a final job stitches the digests into one tag with
`docker buildx imagetools create`.

One job with `platforms: linux/amd64,linux/arm64` under QEMU would be shorter and does not work:
emulated arm64 makes `prisma generate` fall back to its wasm engine, which rejects
`env("DATABASE_URL")` in the schema (P1012). Native runners also build in roughly a third of the
time.

🔒 **`build-parsers` and `merge-parsers` do the same for the other two images** — `deploy/stirling`
and `deploy/docling`, published as `ghcr.io/<owner>/legere-stirling` and `…-docling` under the tag
the app takes, so `LEGERE_VERSION` names one version of the whole stack
([`SEC-79`](./tasks/security-audit-2026-08-second-pass.md#sec-79)). Three things about them differ
from the app's pair, and each is deliberate:

- **On a `v*` tag only.** `deploy/docker-compose.yaml` pulls `${LEGERE_VERSION:-latest}`, which is
  never a branch name, so a `main` push has nobody to publish for — and these images are gigabytes
  each. What they are made of does not move between releases anyway: both bases are pinned by digest.
- **No `type=gha` build cache.** Their whole content is one enormous pinned base layer, which the
  registry caches already and which would evict everything the app's build keeps in the 10 GB the
  Actions cache gives a repository.
- **Digest artifacts are named per image** (`digest-legere-…`, `digest-stirling-…`,
  `digest-docling-…`). All four builds export into the same run, and a `merge` job collecting
  `digest-*` would happily stitch one image's manifest list out of another image's platforms.

`publish` waits for both merges: a release page that exists is a promise that every image that
version names can be pulled. `scan` runs over all three, and on a `main` push the two parser entries
have nothing to read back and do nothing.

On a `v*` tag a `publish` job follows `merge` and creates the **GitHub Release** from the tag —
nobody writes or clicks anything. The notes are the commit subjects since the previous tag plus the
compare link, assembled in the job itself: GitHub's own `--generate-notes` reads pull requests, and
a repository in its direct-commit mode has none to read, so it would produce a bare compare link.
Commit subjects are Conventional Commits either way — under squash-merge they *are* the PR titles —
so the same notes read correctly in both modes. The job waits for both merges on purpose: a release
page that exists is a promise that `ghcr.io/<owner>/legere:X.Y.Z` — and the two parser images that
version names — can be pulled.

A further job, `scan`, reads the published tags back and fails on a fixed HIGH or CRITICAL finding
in any of the three images. It runs *after* publication rather than over a locally built image so
that what is reported is the artifact deployments pull; it gets neither `packages: write` nor
`contents: write`. A red `scan` is therefore a report, not a rollback: the images are out, and
`npm run release` (§13.3a) says so in as many words, because a failed `scan` and a failed `build`
mean opposite things about what is in the registry.

🔒 **Recorded findings are subtracted first, so a red scan means something new.** The `v0.26.0` scan
— the first over all three images — was red on findings that had been true for weeks and would stay
true until an upstream published a build to move a pin to: both parser pins already sat on their
upstream's newest release, and the app's base floats. The alternative decision, letting a red scan
keep failing on the same recorded set, was considered and refused: a job that is red on every run
for a known reason stops being read, and the next genuinely new finding arrives unread. So each scan
entry is handed an allowlist — `.github/trivyignore/legere`, `…/legere-stirling`,
`…/legere-docling`, one plain `.trivyignore` per image, so a CVE recorded against one image still
fails the scan when it surfaces in another. Every entry is one advisory id under a comment pointing
at its record in [`12 §12.7`](./12-build-config-run.md#127-deployment-deploy-shipped-with-the-repository):
which image carries it, why it is not reachable in this deployment, what would make it reachable.
The two lists move together — no entry without a record, no record without an entry — and an entry
is deleted when the pin move that clears it lands, which is Dependabot's edit to review, not a new
decision. A red scan is then worth stopping for again, and means one of two things: a finding
nobody has recorded, or a recorded one whose record has stopped being true.

```yaml
name: Release
on:
  push:
    branches: [main]
    tags: ['v*']

permissions:
  contents: read      # `packages: write` is granted per job, to the four that publish

env:
  IMAGE: ghcr.io/${{ github.repository }}

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { platform: linux/amd64, runner: ubuntu-latest }
          - { platform: linux/arm64, runner: ubuntu-24.04-arm }
    runs-on: ${{ matrix.runner }}
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: docker/setup-buildx-action@8d2750c68a42422c14e847fe6c8ac0403b4cbd6f # v3.12.0
      - uses: docker/login-action@c94ce9fb468520275223c153574b00df6fe4bcc9 # v3.7.0
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: build
        uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6.19.2
        with:
          context: .
          file: Dockerfile
          platforms: ${{ matrix.platform }}
          outputs: type=image,name=${{ env.IMAGE }},push-by-digest=true,name-canonical=true,push=true
          build-args: |
            NEXT_PUBLIC_TURNSTILE_SITE_KEY=${{ secrets.NEXT_PUBLIC_TURNSTILE_SITE_KEY }}
          cache-from: type=gha,scope=${{ matrix.platform }}
          cache-to: type=gha,mode=max,scope=${{ matrix.platform }}
      # …digest exported as the artifact `digest-legere-<job-index>`…

  # The parsers of 12 §12.7, on a tag only, and without the Actions cache.
  build-parsers:
    if: startsWith(github.ref, 'refs/tags/v')
    strategy:
      fail-fast: false
      matrix:
        parser: [stirling, docling]
        platform: [linux/amd64, linux/arm64]
        include:
          - { platform: linux/amd64, runner: ubuntu-latest }
          - { platform: linux/arm64, runner: ubuntu-24.04-arm }
    runs-on: ${{ matrix.runner }}
    permissions: { contents: read, packages: write }
    steps:
      # …checkout, buildx, ghcr login…
      - id: build
        uses: docker/build-push-action@10e90e3645eae34f1e60eeb005ba3a3d33f178e8 # v6.19.2
        with:
          context: deploy/${{ matrix.parser }}
          platforms: ${{ matrix.platform }}
          outputs: type=image,name=${{ env.IMAGE }}-${{ matrix.parser }},push-by-digest=true,name-canonical=true,push=true
      # …digest exported as the artifact `digest-<parser>-<job-index>`…

  merge:
    needs: build
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    outputs:
      version: ${{ steps.meta.outputs.version }}
    steps:
      # …digests downloaded, metadata-action computes the tags…
      - run: |
          docker buildx imagetools create \
            $(jq -cr '.tags | map("-t " + .) | join(" ")' <<< "$DOCKER_METADATA_OUTPUT_JSON") \
            $(printf "${IMAGE}@sha256:%s " *)

  # The same stitch, once per parser image, over that image's own digest artifacts.
  merge-parsers:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: build-parsers
    strategy:
      fail-fast: false
      matrix:
        parser: [stirling, docling]
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }

  publish:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: [merge, merge-parsers]
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      # …checkout with fetch-depth 0, commit subjects since the previous tag → /tmp/notes.md…
      - env: { GH_TOKEN: '${{ github.token }}' }
        run: |
          gh release view "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" >/dev/null 2>&1 ||
            gh release create "$GITHUB_REF_NAME" --repo "$GITHUB_REPOSITORY" \
              --title "$GITHUB_REF_NAME" --notes-file /tmp/notes.md --verify-tag

  scan:
    name: scan legere${{ matrix.suffix }}
    needs: [merge, merge-parsers]
    # `merge-parsers` is skipped on a branch push, and a skipped dependency would skip this too.
    if: ${{ !cancelled() && needs.merge.result == 'success' }}
    strategy:
      fail-fast: false
      matrix:
        suffix: ['', '-stirling', '-docling']
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: read }
    steps:
      # …checkout (the allowlist lives in the repository), ghcr login…
      - uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        # The parser images exist at a version tag only.
        if: ${{ matrix.suffix == '' || startsWith(github.ref, 'refs/tags/v') }}
        with:
          image-ref: ${{ env.IMAGE }}${{ matrix.suffix }}:${{ needs.merge.outputs.version }}
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: '1'
          # Recorded findings subtracted, one file per image; every entry points at its record
          # in docs/12 §12.7.
          trivyignores: .github/trivyignore/legere${{ matrix.suffix }}
```

- Images: `ghcr.io/<owner>/legere`, tags `main`, `sha-…`, `X.Y.Z` (the semver of the tag, without its
  `v` — that is what `type=semver,pattern={{version}}` writes) and `latest`, the last two published
  by the tag's run only: a push to `main` tags the branch and leaves `latest` where it was. And
  `…/legere-stirling`, `…/legere-docling`, which take `X.Y.Z` and `latest` and nothing else.
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is a **build-arg** (baked into the client bundle at `next build`);
  empty secret → CAPTCHA widget absent, server verification no-op — a working degradation.

## 13.3a. Releasing

A release is **one command** and no judgement calls:

```bash
npm run release            # a minor bump — the usual case in 0.x
npm run release -- patch   # or: major
```

What the command does, in order (`scripts/release.mjs`):

1. **Refuses anything but a clean, pushed `main`.** Not on `main`, a dirty tree, or a local `main`
   that differs from `origin/main` — each is its own refusal, because what is released must be
   exactly what CI looked at.
2. **Gates on the CI that already ran — and waits for it when it has not finished.** It asks GitHub
   for the `CI` workflow runs on `HEAD`'s own SHA and polls every 15 s, printing the elapsed wait on
   one line that rewrites itself: up to 2 minutes for a run to appear at all (a push needs a moment
   to become a run), then up to 30 minutes for it to finish. A wait that outlives its limit becomes
   a refusal naming the run; red is a refusal at once, the failing run's URL being the whole answer.
   Waiting is the point: "not yet" is not "no", and the person who typed the command should not have
   to come back and type it again. 🔒 **Nothing is re-run locally.** The suite was green on this very
   commit in CI; running it again on the same bytes buys a slower copy of an answer that exists. A
   release is cut in the time it takes to bump a number, not in the time it takes to re-earn a green
   that is already on the screen.
3. **Writes the version commit and the tag as one move** — `npm version`, which bumps `package.json`
   (+ lockfile), commits `chore(release): X.Y.Z` and lays the annotated tag `vX.Y.Z` on that very
   commit — then pushes both in one `git push --follow-tags`.
4. **Follows the release build to its end** (§13.3): the tag starts `release.yml`, the
   multi-platform image is published as `X.Y.Z`/`latest`, and the `publish` job creates the GitHub
   Release from the tag, its notes assembled from the commit subjects since the previous tag. The
   command watches that run rather than sending the person to `gh run list`: the one push carries
   the version commit **and** the tag, so GitHub starts two runs on the same SHA, and only the tag's
   moves `latest` — it is the one whose `head_branch` is `vX.Y.Z`, and the one followed here. Same
   rewriting line, now counting jobs (`3/5 jobs`), up to 2 minutes for the run to appear and 60 for
   it to finish: six native builds since the parser images joined the run — the app on two
   architectures and each parser on both — the heaviest of them pushing several gigabytes, and on a
   busy day a queue in front of them.
5. **Ends where "released" means something: `latest` in the registry.** The command asks GHCR itself
   what `latest` and `X.Y.Z` resolve to — an anonymous pull token and a `HEAD` on the manifest, the
   image being public — and finishes only when both are the one digest, which it prints. A red run
   is a refusal naming the jobs that failed, and it says in the line above whether `latest` moved
   anyway, because that is the difference between a failed `build` (no image) and a failed `scan`
   (the image is out and carries a fixable CVE). 🔒 **The push in step 3 is the point of no return**
   — everything after it only watches, so Ctrl-C costs the report, not the release, and a wait that
   outlives its limit says exactly that.

Why this is atomic where the old way was not: the tag points at the version commit **by
construction** (one `npm version` invocation), they travel in one push, and the Release is derived
from the tag **by CI** — three artifacts, one source of truth, no step where a person picks a commit
for a tag or a tag for a release. Nobody writes the notes: the commit subjects are Conventional
Commits and read as a list on their own, and a sentence worth adding can be edited onto the release
page afterwards without holding the release for it.

The version commit itself lands on `main` unreviewed by the gate (it did not exist when CI ran), and
that is fine: it changes two version fields and nothing else, and CI still runs on it after the
fact like on any push. While the repository is in its single-author mode (commits straight to
`main`, CLAUDE.md), the direct push is the same one every other commit takes; under the branch
protection of §13.4 the release script's push would need the maintainer exemption that protection
setup defines.

## 13.4. Branch protection (required)

- `main`: require PR, require `CI / build-and-test`, forbid force-push. Direct pushes — disabled for
  everyone including admins.
- PR titles follow Conventional Commits (squash-merge takes the PR title as the commit subject).

## 13.5. Checklist

- [ ] `ci.yml`: typecheck/lint/test/build against pgvector Postgres; no real external credentials.
- [ ] `release.yml`: the app image to GHCR with meaningful tags, and the two parser images of
      `12 §12.7` under the same version on a `v*` tag; public `NEXT_PUBLIC_*` via build-args.
- [ ] Releases cut by `npm run release` only (§13.3a); the GitHub Release is published by CI from
      the tag, never by hand; the command returns when `latest` points at the image it just cut.
- [ ] Secrets only in GitHub Secrets; `deploy/` ships a compose file and a `.env.example` of
      placeholders, never a real secret ([`12 §12.7`](./12-build-config-run.md)).
- [ ] Branch protection active before the first feature PR.
- [ ] Every workflow declares `permissions:`; no file grants more than the job that needs it.
- [ ] Every third-party action pinned to a commit SHA, version in the trailing comment.
- [ ] `npm audit --omit=dev --audit-level=high` in `build-and-test`, before `npm ci`.
- [ ] Image scan on release, over all three published images; both parser bases pinned
      `tag@sha256:…`; `.github/dependabot.yml` covers npm, `github-actions` and docker.
- [ ] Recorded scan findings subtracted via `.github/trivyignore/<image>`, every entry pointing at
      its record in `12 §12.7`; no entry without a record, no record without an entry.

## 13.6. Open questions

None.
