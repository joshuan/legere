import { Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';
import { EmailSender, type EmailMessage } from '../../application/ports/email-sender';
import { AppConfig } from '../config/app-config';

// SMTP delivery (docs/06 §6.3.3). Used whenever SMTP_HOST is set; otherwise the module binds
// LogEmailSender instead (docs/12 §12.4).
@Injectable()
export class SmtpEmailSender extends EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;
  private readonly host: string;
  private readonly port: number;
  private readonly requiresTls: boolean;

  constructor(config: AppConfig) {
    super();
    this.from = config.get('SMTP_FROM');
    this.host = config.get('SMTP_HOST');
    this.port = config.get('SMTP_PORT');
    this.requiresTls = config.requiresSmtpTls;
    this.transporter = createTransport(smtpTransportOptions(config));
  }

  async send(message: EmailMessage): Promise<void> {
    try {
      await this.transporter.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch (error) {
      if (this.requiresTls && isTlsFailure(error)) {
        // 🔒 The one failure an operator must not read as "mail is broken" (docs/12 §12.8). It is a
        // decision they can make in `.env` in a minute, and the alternative to naming it is a
        // support answer that sends them into the relay's own configuration, where nothing is wrong.
        // Neither this message nor the one it wraps carries the letter: the six-digit code stays out
        // of the log on a failed send exactly as it does on a successful one (docs/08 §8.1.8).
        throw new Error(
          `SMTP refused to encrypt: ${this.host}:${this.port} would not upgrade the connection to TLS, and the letter was not sent rather than sent in the clear with the relay password. Use port 465 with SMTP_SECURE=true, or set SMTP_ALLOW_PLAINTEXT=true if the relay is on this host and you accept an unencrypted session (docs/12 §12.4a). The transport said: ${describe(error)}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

// 🔒 What the transport is built with, and the whole of SEC-62 in one field. Nodemailer upgrades an
// unencrypted session only when the greeting advertises `STARTTLS`, so with nothing set an attacker
// on the path deletes that one line and gets a plaintext session carrying the relay password and
// every six-digit code — no error, every letter delivered, nothing wrong at either end. `requireTLS`
// makes the client issue `STARTTLS` whether or not it was offered and give up when the upgrade does
// not happen, which turns that attack into a failed send.
//
// Exported so the floor can be asserted on the options rather than on a live relay: what is being
// tested is a decision, and a decision is worth reading in one place (docs/12 §12.8).
export function smtpTransportOptions(config: AppConfig): SMTPTransport.Options {
  const user = config.get('SMTP_USER');
  return {
    host: config.get('SMTP_HOST'),
    port: config.get('SMTP_PORT'),
    // Must match the port: 465 → true, 587 → false (docs/12 §12.8).
    secure: config.get('SMTP_SECURE'),
    ...(config.requiresSmtpTls ? { requireTLS: true } : {}),
    ...(user === '' ? {} : { auth: { user, pass: config.get('SMTP_PASSWORD') } }),
  };
}

// Which failures are the upgrade's. `ETLS` is nodemailer's code for exactly this — the relay refused
// `STARTTLS`, or accepted it and the handshake did not complete — and it is the one the stripped
// greeting produces. `ECONNECTION` is not: it is also every unreachable host and refused port, so it
// counts only for the one message nodemailer raises under it when `requireTLS` leaves it no way to
// ask for the upgrade at all. Matching that message is reading prose upstream may reword, which is
// why it is the narrow half: a miss falls through to the original error, and mislabelling a relay
// that is simply down as an encryption problem would send the operator to the wrong file.
function isTlsFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code: unknown = error.code;
  if (code === 'ETLS') return true;
  return code === 'ECONNECTION' && /STARTTLS/i.test(describe(error));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
