import { type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import express, { type Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wireServer } from '../../server/main';
import { AppModule } from '../../src/server/app.module';

// Exercises the one-process wiring (docs/02 §2.2) without Next: the /api dispatcher, the terminal
// JSON 404, and the real health endpoint (real DB via Prisma). Requires the test Postgres (CI service
// / local compose).
describe('API bootstrap (e2e)', () => {
  let server: Express;
  let nestApp: INestApplication;

  beforeAll(async () => {
    server = express();
    nestApp = await NestFactory.create(AppModule, new ExpressAdapter(server), {
      bodyParser: false,
      logger: false,
    });
    await wireServer(server, nestApp, (_req, res) => {
      res.status(200).json({ next: true });
    });
  });

  afterAll(async () => {
    await nestApp.close();
  });

  it('GET /api/health returns the health envelope with a real db check', async () => {
    const res = await request(server).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toMatchObject({ data: { status: 'ok', db: 'ok', queue: 'ok' } });
  });

  it('unknown /api route returns a JSON NOT_FOUND envelope, never HTML', async () => {
    const res = await request(server).get('/api/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Unknown API route', details: null },
    });
  });

  it('non-api routes are dispatched to the Next handler, not Nest', async () => {
    const res = await request(server).get('/some-page');

    expect(res.body).toEqual({ next: true });
  });
});
