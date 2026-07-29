import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { EmailSender, type EmailMessage } from '../../application/ports/email-sender';

// Dev fallback used when SMTP_HOST is empty (docs/08 §8.1.8, docs/12 §12.4): the letter — including
// the verification code — goes to the application log so a single-admin instance can be set up
// without a mail server. Deliberately the only place a code is ever logged, and it is unreachable in
// a configured deployment.
@Injectable()
export class LogEmailSender extends EmailSender {
  constructor(@InjectPinoLogger(LogEmailSender.name) private readonly logger: PinoLogger) {
    super();
  }

  send(message: EmailMessage): Promise<void> {
    this.logger.info(
      { to: message.to, subject: message.subject, text: message.text },
      'Email (SMTP not configured — printing to the log)',
    );
    return Promise.resolve();
  }
}
