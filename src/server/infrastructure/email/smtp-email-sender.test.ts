import { createServer, type Server, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../config/app-config';
import { SmtpEmailSender, smtpTransportOptions } from './smtp-email-sender';

const MINIMAL = {
  APP_BASE_URL: 'http://localhost:3000',
  DATABASE_URL: 'postgresql://legere:legere@localhost:5432/legere',
  AUTH_SECRET: 'x'.repeat(32),
  S3_ACCESS_KEY_ID: 'access-key',
  S3_SECRET_ACCESS_KEY: 'secret-key',
};

const configFor = (env: Record<string, string>) => loadConfig({ ...MINIMAL, ...env });

// 🔒 SEC-62. Nodemailer upgrades an unencrypted session only where the greeting advertises
// `STARTTLS`, so removing that one line used to buy an attacker on the path a plaintext session
// carrying the relay password and every six-digit code — with every letter delivered and nothing
// failing at either end (docs/12 §12.8).
describe('the SMTP transport (docs/12 §12.8)', () => {
  it('requires the upgrade whenever the session does not start encrypted', () => {
    expect(smtpTransportOptions(configFor({ SMTP_HOST: 'smtp.example.com' }))).toMatchObject({
      secure: false,
      requireTLS: true,
    });
  });

  it('asks for no upgrade on 465, where there is nothing to upgrade', () => {
    const options = smtpTransportOptions(
      configFor({ SMTP_HOST: 'smtp.example.com', SMTP_PORT: '465', SMTP_SECURE: 'true' }),
    );

    expect(options.secure).toBe(true);
    expect(options.requireTLS).toBeUndefined();
  });

  it('drops the floor only where the operator asked for it in writing', () => {
    const options = smtpTransportOptions(
      configFor({ SMTP_HOST: 'localhost', SMTP_PORT: '1025', SMTP_ALLOW_PLAINTEXT: 'true' }),
    );

    expect(options.secure).toBe(false);
    expect(options.requireTLS).toBeUndefined();
  });

  it('carries credentials only when there are any', () => {
    expect(smtpTransportOptions(configFor({ SMTP_HOST: 'smtp.example.com' })).auth).toBeUndefined();
    expect(
      smtpTransportOptions(
        configFor({
          SMTP_HOST: 'smtp.example.com',
          SMTP_USER: 'postmaster',
          SMTP_PASSWORD: 's3cr3t',
        }),
      ),
    ).toMatchObject({ auth: { user: 'postmaster', pass: 's3cr3t' } });
  });
});

// Against a relay that behaves exactly as the attack describes: it answers EHLO with a greeting the
// `STARTTLS` line has been deleted from, and refuses the command if asked anyway.
describe('a relay whose greeting has had STARTTLS removed', () => {
  let relay: StubRelay | null = null;

  afterEach(async () => {
    await relay?.close();
    relay = null;
  });

  it('gets an error naming TLS, and no letter', async () => {
    relay = await startStubRelay();
    const sender = new SmtpEmailSender(
      configFor({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(relay.port) }),
    );

    await expect(
      sender.send({ to: 'someone@example.com', subject: 'Your code', text: 'code 123456' }),
    ).rejects.toThrow(/SMTP refused to encrypt/);
    expect(relay.delivered).toHaveLength(0);
  });

  it('says what to change, and never what was in the letter', async () => {
    relay = await startStubRelay();
    const sender = new SmtpEmailSender(
      configFor({ SMTP_HOST: '127.0.0.1', SMTP_PORT: String(relay.port) }),
    );

    const error = await sender
      .send({ to: 'someone@example.com', subject: 'Your code', text: 'code 123456' })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(Error);
    const message = error instanceof Error ? error.message : '';
    // The host and port it could not encrypt to, and both ways out of it.
    expect(message).toContain(`127.0.0.1:${relay.port}`);
    expect(message).toContain('SMTP_SECURE=true');
    expect(message).toContain('SMTP_ALLOW_PLAINTEXT=true');
    // 🔒 And not the code, which is what the letter was carrying (docs/08 §8.1.8).
    expect(message).not.toContain('123456');
  });

  it('delivers to it once the operator has said the relay is on this host', async () => {
    relay = await startStubRelay();
    const sender = new SmtpEmailSender(
      configFor({
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: String(relay.port),
        SMTP_ALLOW_PLAINTEXT: 'true',
      }),
    );

    await sender.send({ to: 'someone@example.com', subject: 'Your code', text: 'code 123456' });

    expect(relay.delivered).toHaveLength(1);
    expect(relay.delivered[0]).toContain('Your code');
  });
});

type StubRelay = {
  readonly port: number;
  readonly delivered: readonly string[];
  close: () => Promise<void>;
};

// Just enough SMTP to be talked to, on the loopback interface, with the one line of the greeting
// that this fix is about left out.
async function startStubRelay(): Promise<StubRelay> {
  const delivered: string[] = [];
  const open = new Set<Socket>();

  const server: Server = createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    // An unexpected reset while a test is tearing down is not a failure of anything.
    socket.on('error', () => socket.destroy());

    let pending = '';
    let body: string | null = null;

    const respond = (line: string): void => {
      if (body !== null) {
        if (line === '.') {
          delivered.push(body);
          body = null;
          socket.write('250 2.0.0 Ok\r\n');
        } else {
          body += `${line}\n`;
        }
        return;
      }

      const command = line.split(' ')[0]?.toUpperCase() ?? '';
      if (command === 'EHLO' || command === 'HELO') {
        // No STARTTLS: the deleted line, and the whole attack.
        socket.write('250-stub\r\n250 SIZE 10485760\r\n');
      } else if (command === 'STARTTLS') {
        socket.write('502 5.5.1 Unrecognized command\r\n');
      } else if (command === 'DATA') {
        body = '';
        socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (command === 'QUIT') {
        socket.write('221 2.0.0 Bye\r\n');
        socket.end();
      } else {
        socket.write('250 2.0.0 Ok\r\n');
      }
    };

    socket.write('220 stub ESMTP\r\n');
    socket.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      for (let at = pending.indexOf('\r\n'); at !== -1; at = pending.indexOf('\r\n')) {
        const line = pending.slice(0, at);
        pending = pending.slice(at + 2);
        respond(line);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the stub relay did not report a port');
  }

  return {
    port: address.port,
    delivered,
    close: async () => {
      for (const socket of open) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
