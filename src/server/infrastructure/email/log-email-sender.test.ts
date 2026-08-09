import { Test } from '@nestjs/testing';
import { LoggerModule } from 'nestjs-pino';
import { describe, expect, it } from 'vitest';
import { LogEmailSender } from './log-email-sender';

// 🔒 SEC-18 (docs/08 §8.1.8, docs/12 §12.4a). The letter that never leaves has to be visible as an
// event and invisible as content: every body this application composes carries a six-digit code,
// and the shipped deployment is the one with no SMTP server, so this is the default sender on a
// real instance rather than a developer's convenience.
//
// A file of its own because nestjs-pino keeps one root logger per process: a suite that has already
// built a silent one cannot then be given a sink to read.
describe('LogEmailSender', () => {
  async function senderWritingTo(lines: string[]): Promise<LogEmailSender> {
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
      providers: [LogEmailSender],
    }).compile();
    return moduleRef.get(LogEmailSender);
  }

  it('logs the recipient and the subject, and never the body', async () => {
    const lines: string[] = [];
    const sender = await senderWritingTo(lines);

    await sender.send({
      to: 'invited@legere.local',
      subject: 'Legere sign-up code',
      text: 'Your Legere code is 123456.\nEnter it at http://localhost:3000 to finish signing up.',
    });

    const written = lines.join('');
    expect(written).toContain('invited@legere.local');
    expect(written).toContain('Legere sign-up code');
    expect(written).not.toContain('123456');
    expect(written).not.toContain('Your Legere code');
  });
});
