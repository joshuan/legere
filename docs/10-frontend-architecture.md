# 10. Frontend Architecture

Next.js (App Router) + React, Feature-Sliced Design, Ant Design, TanStack Query, next-intl.
The frontend is a same-origin client of `/api` — it never imports server code.

## 10.1. Feature-Sliced Design (adapted for Next)

Next owns `src/app` (routing only, thin files); all UI code lives in `src/web` by FSD layers:

```
src/web/
├── screens/      # top-level screen compositions, one slice per route (FSD "pages", renamed)
├── widgets/      # self-contained UI blocks (document-grid, viewer-panel, queue-dashboard, app-sidebar)
├── features/     # user actions (login-form, invite-wizard, scanset-builder, share-collection, document type-picker)
├── entities/     # domain UI + api hooks (document, library, collection, scan-set, document type, user)
└── shared/       # ui-kit wrappers, api client, i18n utils, config, lib (format, hooks)
```

Rules (ESLint-enforced, [`14 §14.2`](./14-coding-standards.md#142-eslint)):
- imports only "downward" (`screens → widgets → features → entities → shared`);
- a slice is imported only via its public API (`index.ts`); deep imports are forbidden;
- `src/web/**` and `src/app/**` never import `src/server/**`; shared code only from
  `src/shared/contracts`.

Route files in `src/app` do nothing but compose: `export { DocumentsScreen as default } from
'.../screens/documents'` plus metadata.

## 10.2. Routing map

```
src/app/
├── (public)/
│   ├── login/page.tsx
│   ├── onboarding/page.tsx          # first-admin setup (404 when already onboarded)
│   ├── invite/[token]/page.tsx      # invite landing → 3-step wizard
│   └── reset/[token]/page.tsx       # password-reset landing → wizard
├── (app)/                           # session-guarded
│   ├── layout.tsx                   # sidebar shell; fetches /api/me server-side
│   ├── documents/page.tsx           # grid + filters (default screen, redirect from /)
│   ├── documents/[id]/page.tsx      # viewer
│   ├── browse/[libraryId]/page.tsx  # folder browsing (?path=)
│   ├── search/page.tsx
│   ├── collections/page.tsx
│   ├── collections/[id]/page.tsx
│   ├── scan-sets/page.tsx
│   ├── scan-sets/[id]/page.tsx
│   ├── settings/page.tsx
│   └── admin/                       # role-guarded (ADMIN)
│       ├── libraries/page.tsx  ├── libraries/[id]/page.tsx
│       ├── users/page.tsx      ├── document types/page.tsx
│       └── queue/page.tsx
├── layout.tsx                       # html/body, AntdRegistry, providers
├── error.tsx / global-error.tsx / not-found.tsx
└── favicon.ico
```

**Guards:** the `(app)` layout is an async server component: it calls `GET /api/me` (forwarding
cookies via `headers()`); 401 → `redirect('/login?returnTo=...')`. The `admin` segment layout
additionally checks `role === 'ADMIN'`, else `notFound()`. Client-side, a 401 from any query triggers
a redirect to `/login` (see §10.5).

## 10.3. i18n (next-intl, no locale routing)

- Locale is **not** in the URL. Resolution order (server, `src/i18n/request.ts`): `NEXT_LOCALE`
  cookie → `Accept-Language` → `en`. After login/`PATCH /api/me` the server sets `NEXT_LOCALE` =
  `User.language` (lower-cased).
- Catalogs `messages/en.json` (reference) and `messages/ru.json`; keys namespaced by slice
  (`documents.list.empty`, `admin.queue.retry`). No raw user-facing strings in JSX — only
  `useTranslations`. ICU plurals/dates via next-intl formatters.
- API errors are localized by `code`: `shared/api/error-messages.ts` maps every `ErrorCode` from
  contracts to a message key (exhaustive `Record<ErrorCode, string>` — a new code without a mapping
  is a type error).

## 10.4. Ant Design

- `@ant-design/nextjs-registry` (`AntdRegistry`) in the root layout for SSR style extraction.
- One `ConfigProvider` in providers: theme algorithm from the user's `theme` setting (`SYSTEM` →
  `matchMedia('prefers-color-scheme')`, listened live), antd locale (`enUS`/`ruRU`) synced with
  next-intl locale.
- No custom CSS framework; component styling via antd tokens and CSS modules for layout glue only.

## 10.5. Server state (TanStack Query v5)

- One `QueryClient` in providers: `staleTime: 30s`, `retry: (failures, err) => failures < 2 &&
  err.status >= 500` (never retry 4xx), `refetchOnWindowFocus: false`.
- **API client** (`src/web/shared/api/client.ts`): a `fetch` wrapper —
  `request(method, path, { body?, query?, schema })`:
  - same-origin, `credentials: 'include'`, `Content-Type: application/json`;
  - non-2xx → parse envelope, throw typed `ApiError { code, status, details }`; network failure →
    `ApiError('NETWORK')`;
  - 2xx → parse envelope and validate `data` with the contracts Zod `schema` — drift fails loudly in
    dev (throws) and logs-only in prod;
  - a global handler: `ApiError` 401 outside `(public)` routes → hard redirect to `/login`.
- Query keys per entity slice: `['documents', filters]`, `['document', id]`, `['collections']`, etc.
  Lists use `useInfiniteQuery` with `nextCursor`. Mutations invalidate the narrowest affected keys.
- **Processing liveness:** the documents list and the viewer poll with `refetchInterval: 5000` while
  any visible document has `processing: true`; the admin queue dashboard polls every 5 s. The
  viewer's other queries — the extracted text, the log — are **not** polled: they are invalidated
  when a step changes state, which is the only moment either can change and is already being
  watched. The log additionally polls while the document is processing, because an entry can appear
  without a step moving — somebody else editing the same document. Artifacts served as URLs (the
  preview image, the canonical PDF) are keyed by the step that produces them: a `<img>` asked for
  before the file existed is a broken image the browser will never retry on its own
  unconditionally.

## 10.6. Forms

`react-hook-form` + `@hookform/resolvers/zod`, schemas imported from `src/shared/contracts` (the same
schema the server validates with). Server `VALIDATION_FAILED.details.issues` are mapped back to field
errors; other `ApiError`s surface per §10.7.

## 10.7. Error handling (three levels)

1. **Render errors:** `error.tsx` (segment), `global-error.tsx`, `not-found.tsx` — localized, with a
   "retry" action.
2. **Component level:** an `ErrorBoundary` widget wraps independently-failing widgets (viewer panel,
   queue dashboard).
3. **API errors:** typed `ApiError` → three presentations: form field/summary (mutations from forms),
   antd `message` toast (imperative actions: retry job, share, merge), inline error state with retry
   (queries backing a section). The mapping `code → message key` is exhaustive (§10.3).

## 10.8. Media in the UI

Previews/thumbnails are plain `<img src="/api/documents/:id/thumb">` — the API 302-redirects to a
signed URL; the browser follows it transparently. The PDF viewer embeds
`/api/documents/:id/canonical` (or `/source` for PDFs) inside an `<iframe>`/`<object>` — native
browser PDF rendering, no JS PDF library in MVP. The Markdown tab renders the string from
`/markdown` with `react-markdown` + `remark-gfm`, sanitized (no raw HTML pass-through).

## 10.9. Open questions

None.
