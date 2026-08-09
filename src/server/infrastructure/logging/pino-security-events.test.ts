import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CallContext } from '../../application/ports/call-context';
import { SecurityEvents } from '../../application/ports/security-events';
import { AsyncLocalCallContext } from './async-call-context';
import { PinoSecurityEvents } from './pino-security-events';

// 🔒 SEC-34 (docs/06 §6.7). What an account record actually looks like on stdout — the one place
// that can be checked without booting the whole application, and the place the joining field lives:
// a record is written under the id of the call it happened in, which is the id of the request.
//
// A file of its own, and one sink for all of it, for the same reason LogEmailSender has one:
// nestjs-pino keeps a single root logger per process, so a second module built here would go on
// writing to the first module's stream.
describe('PinoSecurityEvents', () => {
  const lines: string[] = [];
  let events: SecurityEvents;
  let calls: CallContext;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({
          pinoHttp: [
            { level: 'trace' },
            {
              write: (line: string) => {
                lines.push(line);
              },
            },
          ],
        }),
      ],
      providers: [
        { provide: CallContext, useClass: AsyncLocalCallContext },
        { provide: SecurityEvents, useClass: PinoSecurityEvents },
      ],
    }).compile();
    events = moduleRef.get(SecurityEvents);
    calls = moduleRef.get(CallContext);
  });

  beforeEach(() => {
    lines.length = 0;
  });

  function written(): Array<Record<string, unknown>> {
    return lines.map((line: string): Record<string, unknown> => {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object') throw new Error(`Not an object: ${line}`);
      return { ...parsed };
    });
  }

  it('writes one JSON line naming the actor, the target and the time', () => {
    events.record({
      event: 'role.changed',
      actor: { userId: 'admin-1' },
      target: { userId: 'user-2' },
      detail: { fromRole: 'USER', role: 'ADMIN' },
    });

    expect(lines).toHaveLength(1);
    expect(written()[0]).toMatchObject({
      context: 'security',
      event: 'role.changed',
      actor: { userId: 'admin-1' },
      target: { userId: 'user-2' },
      detail: { fromRole: 'USER', role: 'ADMIN' },
      msg: 'security.role.changed',
    });
    expect(typeof written()[0]?.['time']).toBe('number');
  });

  it('carries the id of the call it happened in, so a record joins to its request', async () => {
    await calls.run('request-42', () => {
      events.record({ event: 'login.succeeded', actor: { userId: 'user-1' }, target: {} });
      return Promise.resolve();
    });

    expect(written()[0]).toMatchObject({ requestId: 'request-42' });
  });

  it('says the request id is missing rather than inventing one outside a call', () => {
    events.record({ event: 'account.deactivated', actor: { userId: 'admin-1' }, target: {} });

    expect(written()[0]).toMatchObject({ requestId: null });
  });

  it('goes to the same stream as everything else, tagged so it can be picked out of it', () => {
    events.record({ event: 'api_token.created', actor: { userId: 'user-1' }, target: {} });

    // An operator with nothing but `docker compose logs app` has two handles on these lines: a JSON
    // field, and a message prefix for when the reader does not parse JSON (docs/06 §6.7).
    expect(lines.filter((line) => line.includes('"context":"security"'))).toHaveLength(1);
    expect(lines.filter((line) => line.includes('"msg":"security.'))).toHaveLength(1);
  });
});
