import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  MODULE_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../../app.module';
import { DocumentAccessGuard } from '../documents/document-access.guard';
import { ROLES_KEY, RolesGuard } from './roles.guard';
import { SessionGuard } from './session.guard';

// 🔒 docs/08 §8.6: "Every protected route — `SessionGuard` (+ `RolesGuard`/`DocumentAccessGuard`)".
// "Every" is a claim about the whole route table, and a route table is exactly the thing nobody
// re-reads. So it is read here instead: the composition root is walked the way Nest walks it, and
// every route it finds is held to the rule its path implies. A controller mounted without a guard,
// or an `/api/admin` route that carries `RolesGuard` and forgets to say which role, fails this file
// on the commit that introduces it rather than in the next audit (docs/08 §8.5, docs/06 §6.4).

// `Reflect.getMetadata` and `Reflect.get` are typed `any`. Binding them once through an explicit
// signature keeps the rest of this file in `unknown`, so nothing here needs a type assertion
// (docs/14 §14.1).
const metadataOf: (key: string, target: object) => unknown = Reflect.getMetadata;
const propertyOf: (target: object, key: string) => unknown = Reflect.get;

type ControllerClass = { readonly name: string; readonly prototype: object };

type Route = {
  // `ControllerName.handlerName` — what a reader of a failure message can grep for.
  readonly id: string;
  // The path Nest mounts, under the global `api` prefix (server/main.ts).
  readonly path: string;
  readonly guards: readonly unknown[];
  readonly roles: readonly unknown[];
};

// The routes docs/07 §7.3 serves to a caller who has no session yet, with the reason each one has to
// be reachable before there is anything to authenticate. Anything not on this list is protected.
const PUBLIC_ROUTES = new Map<string, string>([
  ['HealthController.get', 'the container liveness probe, before anyone has signed in (06 §6.10)'],
  ['AuthController.onboarding', 'the page has to learn whether the instance has an admin yet'],
  ['AuthController.registerStart', 'step 1 of §8.1.3: there is no account to guard yet'],
  ['AuthController.registerVerify', 'step 2 of §8.1.3'],
  ['AuthController.registerComplete', 'step 3 of §8.1.3, which is what creates the account'],
  ['AuthController.signIn', 'login itself'],
  ['InvitesController.preview', 'the invite landing page; throttled per IP instead (§8.4)'],
  ['PasswordResetsController.preview', 'the reset landing page; throttled per IP instead (§8.4)'],
]);

const routes = collectRoutes();

describe('the route table (🔒 docs/08 §8.6)', () => {
  it('finds every controller the application mounts', () => {
    // A sanity floor: if the walk below ever stops descending into the module graph, every other
    // assertion in this file would pass vacuously.
    expect(routes.length).toBeGreaterThan(50);
    expect(new Set(routes.map((route) => route.id)).size).toBe(routes.length);
  });

  it('puts every route that is not deliberately public behind SessionGuard', () => {
    const unguarded = routes
      .filter((route) => !PUBLIC_ROUTES.has(route.id))
      .filter((route) => !route.guards.includes(SessionGuard))
      .map((route) => `${route.id} (${route.path})`);

    expect(unguarded).toEqual([]);
  });

  it('keeps no route in its public list that the application no longer serves', () => {
    const known = new Set(routes.map((route) => route.id));
    const stale = [...PUBLIC_ROUTES.keys()].filter((id) => !known.has(id));

    expect(stale).toEqual([]);
  });

  it('lets nothing under /api/admin through without RolesGuard and the ADMIN role it enforces', () => {
    // 🔒 The guard alone decides nothing: with no `@Roles` it waves everybody through (roles.guard).
    const unenforced = routes
      .filter((route) => route.path === 'admin' || route.path.startsWith('admin/'))
      .filter((route) => !route.guards.includes(RolesGuard) || !route.roles.includes('ADMIN'))
      .map((route) => `${route.id} (${route.path})`);

    expect(unenforced).toEqual([]);
    // And the admin surface exists, so the filter above is not matching nothing.
    expect(routes.some((route) => route.path.startsWith('admin/'))).toBe(true);
  });

  it('resolves the document before every route that names one, unless the route is admin-only', () => {
    // 🔒 docs/08 §8.5: visibility and sharing are decided by `DocumentAccessGuard`, once, from the
    // path parameter — including on the file and artifact routes, which is where this bug usually
    // lives. The exceptions are the two routes reserved for administrators (`@Roles('ADMIN')`), who
    // see everything, so there is nothing left for the access guard to decide.
    const unresolved = routes
      .filter((route) => route.path.startsWith('documents/:id'))
      .filter(
        (route) => !route.guards.includes(DocumentAccessGuard) && !route.roles.includes('ADMIN'),
      )
      .map((route) => `${route.id} (${route.path})`);

    expect(unresolved).toEqual([]);
    // The file endpoints docs/08 §8.6 names explicitly, so the filter cannot quietly stop matching.
    const guarded = routes
      .filter((route) => route.guards.includes(DocumentAccessGuard))
      .map((route) => route.path);
    expect(guarded).toEqual(
      expect.arrayContaining([
        'documents/:id/files/:fileId/content',
        'documents/:id/canonical',
        'documents/:id/preview',
        'documents/:id/thumb',
        'documents/:id/markdown',
        'documents/:id/processing-state',
      ]),
    );
  });
});

// --- reading the route table -------------------------------------------------------------------

function collectRoutes(): Route[] {
  return controllersOf(AppModule).flatMap(routesOf);
}

// Nest's own traversal: a module's `imports` are classes, or the plain objects a `forRoot` returns.
function controllersOf(entry: unknown, seen: Set<unknown> = new Set()): ControllerClass[] {
  if (entry === null || (typeof entry !== 'object' && typeof entry !== 'function')) return [];
  if (seen.has(entry)) return [];
  seen.add(entry);

  const found: ControllerClass[] = [];
  // A dynamic module names the class it configures and may carry imports of its own.
  found.push(...controllersOf(read(entry, 'module'), seen));
  for (const imported of listAt(entry, MODULE_METADATA.IMPORTS)) {
    found.push(...controllersOf(imported, seen));
  }
  for (const controller of listAt(entry, MODULE_METADATA.CONTROLLERS)) {
    if (isControllerClass(controller)) found.push(controller);
  }
  return found;
}

function routesOf(controller: ControllerClass): Route[] {
  const base = pathOf(metadataOf(PATH_METADATA, controller));
  const classGuards = asList(metadataOf(GUARDS_METADATA, controller));
  const classRoles = asList(metadataOf(ROLES_KEY, controller));

  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = propertyOf(controller.prototype, name);
      // A route handler is the only method carrying an HTTP method: `sendArtifact` and friends do not.
      if (typeof handler !== 'function' || metadataOf(METHOD_METADATA, handler) === undefined) {
        return [];
      }
      const suffix = pathOf(metadataOf(PATH_METADATA, handler));
      const methodRoles = asList(metadataOf(ROLES_KEY, handler));
      return [
        {
          id: `${controller.name}.${name}`,
          path: [base, suffix].filter((part) => part !== '').join('/'),
          guards: [...classGuards, ...asList(metadataOf(GUARDS_METADATA, handler))],
          // `@Roles` on the method overrides the controller's, exactly as `RolesGuard` reads it.
          roles: methodRoles.length > 0 ? methodRoles : classRoles,
        },
      ];
    });
}

function isControllerClass(value: unknown): value is ControllerClass {
  return typeof value === 'function' && typeof propertyOf(value, 'prototype') === 'object';
}

function read(entry: object, key: string): unknown {
  return key in entry ? propertyOf(entry, key) : undefined;
}

// Where a module's imports live depends on what it is: metadata on a class, a plain property on the
// object a `forRoot` returned.
function listAt(entry: object, key: string): readonly unknown[] {
  return typeof entry === 'function' ? asList(metadataOf(key, entry)) : asList(read(entry, key));
}

function asList(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

// `@Get('years')`, `@Get()` and `@Controller('admin/users')` all end up here; a bare decorator
// records '/' rather than nothing.
function pathOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.replace(/^\/+|\/+$/g, '');
  return trimmed;
}
