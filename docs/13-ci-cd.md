# 13. CI/CD (GitHub Actions)

CI validates every PR and builds **one** application image published to **GHCR**. Deployment is not
described in the repository (example only — [`12 §12.7`](./12-build-config-run.md#127-deployment-example-illustration--keep-outside-the-repository)).

## 13.1. Principles

- Every PR must be green: `typecheck` + `lint` + `test` + `build`. `main` is protected: PRs only,
  required status check `CI / build-and-test` (ADR-014).
- Node from `.nvmrc` (`actions/setup-node` with `node-version-file`), npm cache.
- Integration tests run against a PostgreSQL **pgvector** service container.
- External services are not needed in CI: `FileStorage`, `PdfToolbox`, `EmailSender`,
  `CaptchaVerifier`, `EmbeddingProvider`, `DocumentClassifier` are mocked behind their ports
  ([`14 §14.8`](./14-coding-standards.md#148-testing)). Dummy env values exist only to satisfy config
  validation.
- On `main`/tags: build and push a single Docker image. **No deploy job.**

## 13.2. `.github/workflows/ci.yml`

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]

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
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version-file: .nvmrc, cache: npm }
      - run: npm ci
      - run: npm run db:generate
      - run: npm run db:migrate          # apply migrations to the test DB
      - run: npm run typecheck
      - run: npm run lint
      - run: npm run test
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

```yaml
name: Release
on:
  push:
    branches: [main]
    tags: ['v*']

permissions:
  contents: read
  packages: write

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
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - id: build
        uses: docker/build-push-action@v6
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
    steps:
      # …digests downloaded, metadata-action computes the tags…
      - run: |
          docker buildx imagetools create \
            $(jq -cr '.tags | map("-t " + .) | join(" ")' <<< "$DOCKER_METADATA_OUTPUT_JSON") \
            $(printf "${IMAGE}@sha256:%s " *)
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

## 13.6. Open questions

None.
