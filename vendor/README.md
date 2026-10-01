# Unreleased shared design package

Temporary local distribution of `@joshuan/design-system@0.1.0` from
`js-lib/packages/design-system`, implementing the 2026-10-01 shared design contract.
No sibling checkout is needed for npm ci or Docker builds. This file is a dependency,
not a separately maintained fork. Source changes belong in js-lib.

- Tarball SHA-256: `f437f62395a530ea1ae5f69621e4914b4a3847a894afdda1ba69fcc1f83b3f06`
- Source tree SHA-256 (sorted relative paths, NUL, contents; excludes dist/node_modules): `78c92ad55d940e9506540ca0a33bd1f7e7ead0aca3be7c1ab3f3e6691af98a2c`
- Source commit: `ccec62e` in js-lib (local, unpublished).
- Built with Node 24.18.0.

Regenerate in js-lib with `npm run build --workspace @joshuan/design-system`, then
`npm pack --workspace @joshuan/design-system`. Copy the same archive to both consumers,
run `npm install ./vendor/joshuan-design-system-0.1.0.tgz --save-exact` and update these digests.
Do not hand-edit the archive. After the requested Changesets publication, install the
exact registry version and remove vendor/ and the Docker COPY lines together.
