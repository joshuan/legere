import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, type PinoLogger } from 'nestjs-pino';
import { EmailSender, type EmailMessage } from '../../application/ports/email-sender';

// What happens to a letter when SMTP_HOST is empty (docs/08 §8.1.8, docs/12 §12.4a): nothing. The
// recipient and the subject are recorded so an operator can see that the application tried and what
// it tried to send, and the body is not, because every body this application composes carries a
// credential — the six-digit verification code (docs/08 §8.1.3).
//
// 🔒 That code used to go to the log here, and the shipped deployment is the one with no SMTP
// server, so the default instance published its own sign-up codes to anyone who could read
// `docker compose logs app`. A production instance now refuses to start in this state unless the
// operator says otherwise (`ALLOW_UNCONFIGURED_EMAIL`, docs/12 §12.4a); nothing turns the body back
// on, in any environment, because there is no level of log at which a credential is safe.
@Injectable()
export class LogEmailSender extends EmailSender {
  constructor(@InjectPinoLogger(LogEmailSender.name) private readonly logger: PinoLogger) {
    super();
  }

  send(message: EmailMessage): Promise<void> {
    this.logger.warn(
      { to: message.to, subject: message.subject },
      'Email not sent: SMTP is not configured, and the message body is never logged',
    );
    return Promise.resolve();
  }
}
