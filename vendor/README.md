# Unreleased shared design package

Temporary local distribution of `@joshuan/design-system@0.1.0` from
`js-lib/packages/design-system`, implementing the 2026-10-01 shared design contract.
No sibling checkout is needed for npm ci or Docker builds. This file is a dependency,
not a separately maintained fork. Source changes belong in js-lib.

- Tarball SHA-256: `760f25be09107a3eea3a75f8385ac8ca2dc63a6955d49201a46ba71e84cc9833`
- Source tree SHA-256 (sorted relative paths, NUL, contents; excludes dist/node_modules): `8910d7c63b035ec734f9b95e3b21346263f3de620eeae1b8f44899dd1f62f494`
- Source commit: `4d7f65b` in js-lib (pushed; first npm publication awaits registry 2FA).
- Built with Node 24.18.0.

Regenerate in js-lib with `npm run build --workspace @joshuan/design-system`, then
`npm pack --workspace @joshuan/design-system`. Copy the same archive to both consumers,
run `npm install ./vendor/joshuan-design-system-0.1.0.tgz --save-exact` and update these digests.
Do not hand-edit the archive. After the requested Changesets publication, install the
exact registry version and remove vendor/ and the Docker COPY lines together.
