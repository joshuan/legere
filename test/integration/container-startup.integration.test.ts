import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const projectFile = (path: string): string => resolve(process.cwd(), path);

describe('production image startup', () => {
  it('migrates both schemas before starting the server without relying on Compose', async () => {
    const [dockerfile, start, compose] = await Promise.all([
      readFile(projectFile('Dockerfile'), 'utf8'),
      readFile(projectFile('deploy/start.sh'), 'utf8'),
      readFile(projectFile('deploy/docker-compose.yaml'), 'utf8'),
    ]);

    expect(dockerfile).toContain('COPY --chmod=755 deploy/start.sh ./start.sh');
    expect(dockerfile).toContain('ENTRYPOINT ["./start.sh"]');
    expect(dockerfile).toContain('CMD ["node", "dist/server/main.js"]');

    const prisma = start.indexOf('./node_modules/.bin/prisma migrate deploy');
    const queue = start.indexOf('node dist/server/migrate-queue.js');
    const application = start.indexOf('exec "$@"');
    expect(prisma).toBeGreaterThan(-1);
    expect(queue).toBeGreaterThan(prisma);
    expect(application).toBeGreaterThan(queue);
    expect(start).toContain('set -eu');

    expect(compose).not.toMatch(/^\s{2}(migrate|queue-migrate|database-permissions):/m);
    expect(compose).not.toContain("command: ['node', 'dist/server/main.js']");
    expect(compose).toContain(
      'DATABASE_URL: postgresql://legere:${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}@db:5432/legere?schema=public',
    );
  });
});
