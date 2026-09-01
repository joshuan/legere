import { Injectable } from '@nestjs/common';
import {
  SmtpEmailSender as SharedSmtpEmailSender,
  smtpTransportOptions as sharedSmtpTransportOptions,
  type SmtpOptions,
} from '@joshuan/auth-adapters';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { EmailSender, type EmailMessage } from '../../application/ports/email-sender';
import { AppConfig } from '../config/app-config';

@Injectable()
export class SmtpEmailSender extends EmailSender {
  private readonly shared: SharedSmtpEmailSender;

  constructor(config: AppConfig) {
    super();
    this.shared = new SharedSmtpEmailSender(optionsFrom(config));
  }

  send(message: EmailMessage): Promise<void> {
    return this.shared.send(message);
  }
}

export function smtpTransportOptions(config: AppConfig): SMTPTransport.Options {
  return sharedSmtpTransportOptions(optionsFrom(config));
}

function optionsFrom(config: AppConfig): SmtpOptions {
  const host = config.get('SMTP_HOST');
  const port = config.get('SMTP_PORT');
  return {
    host,
    port,
    secure: config.get('SMTP_SECURE'),
    user: config.get('SMTP_USER'),
    password: config.get('SMTP_PASSWORD'),
    from: config.get('SMTP_FROM'),
    allowPlaintext: config.get('SMTP_ALLOW_PLAINTEXT'),
    tlsFailureMessage: ({ cause }) =>
      `SMTP refused to encrypt: ${host}:${port} would not upgrade the connection to TLS, and the letter was not sent rather than sent in the clear with the relay password. Use port 465 with SMTP_SECURE=true, or set SMTP_ALLOW_PLAINTEXT=true if the relay is on this host and you accept an unencrypted session (docs/12 §12.4a). The transport said: ${describe(cause)}`,
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
