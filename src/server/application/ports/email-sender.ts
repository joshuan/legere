// Outbound email (docs/06 §6.3.3). Bodies carry verification codes and invite links, so they are
// never logged in production paths (docs/06 §6.7).
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

export abstract class EmailSender {
  abstract send(message: EmailMessage): Promise<void>;
}
