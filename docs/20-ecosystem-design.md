# 20. Shared ecosystem design

Decision 2026-10-01: Legere and Rent Manager share one design system in `js-lib`.
The user explicitly permits coordinated stack upgrades; no Ant Design 5 compatibility layer.

`@joshuan/design-system` owns palettes, Ant Design configuration, dimensions, page headings and
OS appearance subscriptions. Legere keeps green, Rent Manager blue; both use IBM Plex Sans/Mono,
neutral surfaces, 40 px controls, 24 px headings (20 on phones), 240 px navigation and 6/8/12 px
corners. This supersedes differing values in docs 11/16. Local components own routes, translations,
auth policy, document composition and apartment workflows. Existing domain rules remain unchanged.

Legere aligns Next, React, Ant Design, icons and SSR registry with Rent Manager. The v5 React patch
and Next 15 build-lint option are removed; request-path forwarding moves to Next 16 proxy.
AntD 6 body/content and modal container selectors replace v5 DOM assumptions. Legacy Alert,
Space, Tag and Drawer props migrate to the current API. Backend/Prisma/Zod versions need not change for this work.
Tooltips retain readable text in either theme. Opening a crop or move dialog dismisses the
page-action hints underneath it, including hover emulated by a touch device.

Canonical contract, extraction audit and identity proposal: `../js-lib/docs/design-system.md`
relative to the repository root. The next candidates are browser HTTP transport, S3 transport,
hydration readiness and small MCP helpers, after their real contracts are aligned. Do not extract
Prisma repositories, domain models, money rules, permissions or whole application providers.

Rent Manager already consumes personal archive references through OAuth + PKCE (docs 19). A shared
passport remains a proposal: OIDC identity by issuer/subject, local sessions and local authorisation,
explicit account linking, no matching by email or shared cookies. No auth/schema migration here.
See [OIDC Core](https://openid.net/specs/openid-connect-core-1_0.html) and
[OAuth Security BCP](https://www.rfc-editor.org/rfc/rfc9700.html).

Both applications install the exact public npm dependency `@joshuan/design-system@0.2.1`.
The package is released from js-lib through Changesets and GitHub Actions OIDC with provenance.
The temporary vendor archive and its Docker COPY steps have been removed. A clean checkout
requires only the registry dependency; production deployment remains a separate operation.

Acceptance: package type/lint/unit/pack checks, both application type/lint/unit suites, production
builds and canonical responsive browser suites. Review screenshots before updating baselines and
rerun comparisons without update. Record actual results and limitations in the backlog.


Navigation completion (2026-10-01): both applications use the shared NavigationFrame. The sidebar
is 240/64 px, initially compact at 768–1023 px; below 768 px it becomes a 280 px drawer. Explicit
collapse choice survives client navigation and desktop resizing. Every brand is a home link with
an icon and name; the compact rail shows the icon with the full accessible name. Mobile links,
route changes, Escape and widening the viewport close the drawer. The toggle is 44 px at the foot
of the sidebar in both products. This supersedes the wordmark-only treatment in docs 11/16.
Application releases follow docs 13, including green hosted checks and registry verification.

The shared stylesheet bundles the verified IBM Plex WOFF2 files, SIL OFL license and SHA-256
manifest, and defines both font variables with the original fallback metrics. Neither build nor
runtime fetches Google Fonts. This avoids [Next.js issue 99114](https://github.com/vercel/next.js/issues/99114)
without changing the accepted typography. Canonical baselines must compare without updates.
