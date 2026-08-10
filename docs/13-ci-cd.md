# 13. CI/CD (GitHub Actions)

CI validates every PR and builds **one** application image published to **GHCR**. Deployment is not
described in the repository (example only — [`12 §12.7`](./12-build-config-run.md#127-deployment-example-illustration--keep-outside-the-repository)).

## 13.1. Principles

- Every PR must be green: `typecheck` + `lint` + `test` + `build`. `main` is protected: PRs only,
  required status check `CI / build-and-test` (ADR-014).
- Node from `.nvmrc` (`actions/setup-node` with `node-version-file`), npm cache.
- Integration tests run against a PostgreSQL **pgvector** service container.
- External services are not needed in CI: `FileStorage`, `PdfToolbox`, `EmailSender`,
  `CaptchaVerifier`, `EmbeddingProvider`, `DocumentAnalyst` are mocked behind their ports
  ([`14 §14.8`](./14-coding-standards.md#148-testing)). Dummy env values exist only to satisfy config
  validation.
- On `main`/tags: build and push a single Docker image. **No deploy job.**

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
- **An image scan on release.** The audit sees the lockfile and nothing below it; the base image is
  where the native libraries live — including libvips, whose four CVEs (SEC-07) are the reason this
  section exists.

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

### Dependabot

`.github/dependabot.yml` watches three ecosystems weekly — npm at the root, `github-actions` (which
keeps the SHA pins above from freezing), and `docker` for the three base images (`/`,
`/deploy/docling`, `/deploy/stirling`). Minor and patch updates are grouped into one pull request per
ecosystem; majors come one at a time, because those are the ones that need a person to read a
migration guide. This is the half of the answer the audit does not give: `npm audit` says something
is wrong, Dependabot arrives with the fix already written and CI green or not on it.

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

Triggered by a push to `main` (image tags `main`, `sha-…`) and by a `v*` tag. The tag is not created
by CI: a maintainer publishes a GitHub Release, GitHub creates the tag, and that push starts the
build — so the release notes are written by a person and the image follows from them.

The image is **multi-platform** (`linux/amd64`, `linux/arm64`): the quickstart of the root
`README.md` is a `docker compose up`, and self-hosters run it on Apple Silicon and ARM servers as
readily as on x86. Each platform builds on a runner of its own architecture and pushes an untagged
manifest **by digest**; a final job stitches the digests into one tag with
`docker buildx imagetools create`.

One job with `platforms: linux/amd64,linux/arm64` under QEMU would be shorter and does not work:
emulated arm64 makes `prisma generate` fall back to its wasm engine, which rejects
`env("DATABASE_URL")` in the schema (P1012). Native runners also build in roughly a third of the
time.

A third job, `scan`, reads the published tag back and fails on a fixed HIGH or CRITICAL finding. It
runs *after* publication rather than over a locally built image so that what is reported is the
artifact deployments pull, and it is the only job in the file that does not get `packages: write`.

```yaml
name: Release
on:
  push:
    branches: [main]
    tags: ['v*']

permissions:
  contents: read      # `packages: write` is granted per job, to the two that publish

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
      # …digest exported as an artifact…

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

  scan:
    needs: merge
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: read }
    steps:
      # …ghcr login…
      - uses: aquasecurity/trivy-action@ed142fd0673e97e23eac54620cfb913e5ce36c25 # v0.36.0
        with:
          image-ref: ${{ env.IMAGE }}:${{ needs.merge.outputs.version }}
          severity: HIGH,CRITICAL
          ignore-unfixed: true
          exit-code: '1'
```

- Image: `ghcr.io/<owner>/legere`, tags `main`, `sha-…`, `vX.Y.Z` (+ `latest` for semver tags).
- `NEXT_PUBLIC_TURNSTILE_SITE_KEY` is a **build-arg** (baked into the client bundle at `next build`);
  empty secret → CAPTCHA widget absent, server verification no-op — a working degradation.

## 13.4. Branch protection (required)

- `main`: require PR, require `CI / build-and-test`, forbid force-push. Direct pushes — disabled for
  everyone including admins.
- PR titles follow Conventional Commits (squash-merge takes the PR title as the commit subject).

## 13.5. Checklist

- [ ] `ci.yml`: typecheck/lint/test/build against pgvector Postgres; no real external credentials.
- [ ] `release.yml`: one image to GHCR with meaningful tags; public `NEXT_PUBLIC_*` via build-args.
- [ ] Secrets only in GitHub Secrets; `deploy/` ships a compose file and a `.env.example` of
      placeholders, never a real secret ([`12 §12.7`](./12-build-config-run.md)).
- [ ] Branch protection active before the first feature PR.
- [ ] Every workflow declares `permissions:`; no file grants more than the job that needs it.
- [ ] Every third-party action pinned to a commit SHA, version in the trailing comment.
- [ ] `npm audit --omit=dev --audit-level=high` in `build-and-test`, before `npm ci`.
- [ ] Image scan on release; `.github/dependabot.yml` covers npm, `github-actions` and docker.

## 13.6. Open questions

None.
