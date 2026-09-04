import { describe, expect, it } from 'vitest';
import { migrationPrisma, testPrisma } from '../helpers/db';

type RuntimeRoleProof = {
  role: string;
  statementTimeout: string;
  superuser: boolean;
  createDatabase: boolean;
  createRole: boolean;
  bypassRls: boolean;
  databaseCreate: boolean;
  publicCreate: boolean;
  publicSelect: boolean;
  publicInsert: boolean;
  publicUpdate: boolean;
  publicDelete: boolean;
  publicTruncate: boolean;
  migrationHistorySelect: boolean;
  queueCreate: boolean;
  queueOwnedByRuntime: boolean;
  queueSelect: boolean;
  queueInsert: boolean;
  queueCreateFunction: boolean;
  queueDeleteFunction: boolean;
  queueFunctionsSecurityDefiner: boolean;
};

// CI runs the application and its complete test suite with this role. The flag keeps a developer's
// ordinary owner-backed test database useful while making the production privilege contract a
// mandatory, live PostgreSQL assertion on every push (SEC-43, docs/12 §12.7).
describe.skipIf(process.env.RUNTIME_DATABASE_ROLE_TEST !== 'true')(
  'the production database runtime role (integration)',
  () => {
    it('can change application rows and operate pg-boss, but cannot perform schema DDL', async () => {
      const db = testPrisma();
      const [proof] = await db.$queryRaw<RuntimeRoleProof[]>`
        SELECT
          current_user AS role,
          current_setting('statement_timeout') AS "statementTimeout",
          r.rolsuper AS superuser,
          r.rolcreatedb AS "createDatabase",
          r.rolcreaterole AS "createRole",
          r.rolbypassrls AS "bypassRls",
          has_database_privilege(current_user, current_database(), 'CREATE') AS "databaseCreate",
          has_schema_privilege(current_user, 'public', 'CREATE') AS "publicCreate",
          has_table_privilege(current_user, 'public.users', 'SELECT') AS "publicSelect",
          has_table_privilege(current_user, 'public.users', 'INSERT') AS "publicInsert",
          has_table_privilege(current_user, 'public.users', 'UPDATE') AS "publicUpdate",
          has_table_privilege(current_user, 'public.users', 'DELETE') AS "publicDelete",
          has_table_privilege(current_user, 'public.users', 'TRUNCATE') AS "publicTruncate",
          has_table_privilege(current_user, 'public._prisma_migrations', 'SELECT')
            AS "migrationHistorySelect",
          has_schema_privilege(current_user, 'pgboss', 'CREATE') AS "queueCreate",
          pg_get_userbyid(n.nspowner) = current_user AS "queueOwnedByRuntime",
          has_table_privilege(current_user, 'pgboss.queue', 'SELECT') AS "queueSelect",
          has_table_privilege(current_user, 'pgboss.queue', 'INSERT') AS "queueInsert",
          has_function_privilege(current_user, 'pgboss.create_queue(text,json)', 'EXECUTE')
            AS "queueCreateFunction",
          has_function_privilege(current_user, 'pgboss.delete_queue(text)', 'EXECUTE')
            AS "queueDeleteFunction",
          EXISTS (
            SELECT FROM pg_proc helper
            JOIN pg_namespace helper_schema ON helper_schema.oid = helper.pronamespace
            WHERE helper_schema.nspname = 'pgboss'
              AND helper.proname IN ('create_queue', 'delete_queue')
              AND helper.prosecdef
          ) AS "queueFunctionsSecurityDefiner"
        FROM pg_roles r
        JOIN pg_namespace n ON n.nspname = 'pgboss'
        WHERE r.rolname = current_user
      `;

      expect(proof).toEqual({
        role: 'legere_app',
        statementTimeout: '30s',
        superuser: false,
        createDatabase: false,
        createRole: false,
        bypassRls: false,
        databaseCreate: false,
        publicCreate: false,
        publicSelect: true,
        publicInsert: true,
        publicUpdate: true,
        publicDelete: true,
        publicTruncate: false,
        migrationHistorySelect: false,
        queueCreate: false,
        queueOwnedByRuntime: false,
        queueSelect: true,
        queueInsert: true,
        queueCreateFunction: false,
        queueDeleteFunction: false,
        queueFunctionsSecurityDefiner: false,
      });

      let publicDdlDenied = false;
      try {
        await db.$executeRawUnsafe('CREATE TABLE public.sec43_must_be_denied (id integer)');
      } catch {
        publicDdlDenied = true;
      } finally {
        await migrationPrisma().$executeRawUnsafe(
          'DROP TABLE IF EXISTS public.sec43_must_be_denied',
        );
      }
      expect(publicDdlDenied).toBe(true);

      let queueDdlDenied = false;
      try {
        await db.$executeRawUnsafe('CREATE TABLE pgboss.sec43_must_be_denied (id integer)');
      } catch {
        queueDdlDenied = true;
      } finally {
        await migrationPrisma().$executeRawUnsafe(
          'DROP TABLE IF EXISTS pgboss.sec43_must_be_denied',
        );
      }
      expect(queueDdlDenied).toBe(true);

      // The owner-only queue migration created all fixed queues and partitions before runtime. The
      // application can use them, but neither DDL helper is an executable DoS primitive.
      const [queue] = await db.$queryRaw<{ name: string }[]>`
        SELECT name FROM pgboss.queue WHERE name = 'maintenance'
      `;
      expect(queue?.name).toBe('maintenance');
    });
  },
);
