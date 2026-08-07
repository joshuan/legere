import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { AuthenticateApiToken } from '../../application/auth/authenticate-api-token';
import {
  AuthenticateSession,
  type AuthenticatedCaller,
} from '../../application/auth/authenticate-session';
import type { User } from '../../domain/entities/user';
import type { ApiToken } from '../../domain/repositories/api-token.repository';
import { DomainExceptionFilter } from '../http/domain-exception.filter';
import { SessionGuard } from './session.guard';

// 🔒 This suite exists to prove the *second* of the two layers docs/08 §8.2a describes. In the real
// server a bearer credential on a mutating method never reaches the guard — `readOnlyBearer` refuses
// it before routing — so the only way to see whether the guard would also refuse is to stand it up
// without that middleware, which is exactly what a Nest testing module does.

const NOW = new Date('2026-08-06T12:00:00.000Z');

const OWNER: User = {
  id: 'a3f0f1c2-0000-4000-8000-000000000001',
  email: 'owner@legere.local',
  passwordHash: 'not used by this suite',
  displayName: 'Owner',
  role: 'USER',
  language: 'EN',
  theme: 'SYSTEM',
  deactivatedAt: null,
  createdAt: NOW,
};

const TOKEN: ApiToken = {
  id: 'a3f0f1c2-0000-4000-8000-000000000002',
  userId: OWNER.id,
  name: 'a backup script',
  tokenHash: 'not used by this suite',
  expiresAt: new Date('2026-11-06T12:00:00.000Z'),
  lastUsedAt: null,
  revokedAt: null,
  createdAt: NOW,
};

// Stand-ins rather than subclasses: both use cases take repositories and a clock this suite has no
// use for, and the guard only ever calls `execute`.
class FakeApiTokens {
  resolved = 0;

  execute(): Promise<AuthenticatedCaller> {
    this.resolved += 1;
    return Promise.resolve({ kind: 'API_TOKEN', user: OWNER, apiToken: TOKEN });
  }
}

class FakeSessions {
  execute(): Promise<AuthenticatedCaller> {
    return Promise.reject(new Error('this suite only presents bearer credentials'));
  }
}

@Controller('probe')
@UseGuards(SessionGuard)
class ProbeController {
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }

  @Post()
  write(): { ok: true } {
    return { ok: true };
  }
}

async function standUpWithoutTheMiddleware(): Promise<{
  server: ReturnType<typeof request>;
  tokens: FakeApiTokens;
  close: () => Promise<void>;
}> {
  const tokens = new FakeApiTokens();
  const moduleRef = await Test.createTestingModule({
    // The exception filter logs through nestjs-pino, which is global in AppModule (docs/06 §6.5).
    imports: [LoggerModule.forRoot({ pinoHttp: { level: 'silent' } })],
    controllers: [ProbeController],
    providers: [
      SessionGuard,
      { provide: AuthenticateApiToken, useValue: tokens },
      { provide: AuthenticateSession, useValue: new FakeSessions() },
      { provide: APP_FILTER, useClass: DomainExceptionFilter },
    ],
  }).compile();

  const app = moduleRef.createNestApplication();
  // Listening on an ephemeral port and asking for the URL, rather than reaching for
  // `getHttpServer()`: that one is typed `any`, and this codebase does not spend type assertions on
  // convenience (docs/14 §14.1).
  await app.listen(0);
  const url = await app.getUrl();

  return { server: request(url), tokens, close: () => app.close() };
}

describe('SessionGuard and a read-only token', () => {
  it('lets a token read', async () => {
    const { server, close } = await standUpWithoutTheMiddleware();

    await server.get('/probe').set('Authorization', 'Bearer legere_whatever').expect(200);

    await close();
  });

  it('refuses a token on a mutating method even with the middleware gone', async () => {
    const { server, close } = await standUpWithoutTheMiddleware();

    const response = await server
      .post('/probe')
      .set('Authorization', 'Bearer legere_whatever')
      .expect(403);
    expect(response.body).toMatchObject({ error: { code: 'READ_ONLY_TOKEN' } });

    await close();
  });

  // The refusal happens before the credential is looked at, so an expired or forged token on a POST
  // is refused for the honest reason rather than for being invalid — and a database is not asked.
  it('refuses without resolving the token at all', async () => {
    const { server, tokens, close } = await standUpWithoutTheMiddleware();

    await server.post('/probe').set('Authorization', 'Bearer legere_whatever').expect(403);
    expect(tokens.resolved).toBe(0);

    await server.get('/probe').set('Authorization', 'Bearer legere_whatever').expect(200);
    expect(tokens.resolved).toBe(1);

    await close();
  });
});
