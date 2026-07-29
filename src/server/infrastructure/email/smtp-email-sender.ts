import { Injectable } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import { EmailSender, type EmailMessage } from '../../application/ports/email-sender';
import { AppConfig } from '../config/app-config';

// SMTP delivery (docs/06 §6.3.3). Used whenever SMTP_HOST is set; otherwise the module binds
// LogEmailSender instead (docs/12 §12.4).
@Injectable()
export class SmtpEmailSender extends EmailSender {
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor(config: AppConfig) {
    super();
    const user = config.get('SMTP_USER');
    const password = config.get('SMTP_PASSWORD');
    this.from = config.get('SMTP_FROM');
    this.transporter = createTransport({
      host: config.get('SMTP_HOST'),
      port: config.get('SMTP_PORT'),
      // Must match the port: 465 → true, 587 → false (docs/12 §12.8).
      secure: config.get('SMTP_SECURE'),
      ...(user === '' ? {} : { auth: { user, pass: password } }),
    });
  }

  async send(message: EmailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: this.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });
  }
}
