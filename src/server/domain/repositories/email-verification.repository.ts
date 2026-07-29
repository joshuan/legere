import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { EmailVerification, VerificationPurpose } from '../entities/email-verification';

export type CreateEmailVerificationInput = {
  email: string;
  purpose: VerificationPurpose;
  codeHash: string;
  expiresAt: Date;
  inviteId: string | null;
  passwordResetId: string | null;
};

export type IssueTicketInput = {
  verifiedAt: Date;
  ticketHash: string;
  ticketExpiresAt: Date;
};

export abstract class EmailVerificationRepository {
  abstract findActive(
    email: string,
    purpose: VerificationPurpose,
    tx?: TransactionHandle,
  ): Promise<EmailVerification | null>;

  abstract findByTicketHash(
    ticketHash: string,
    tx?: TransactionHandle,
  ): Promise<EmailVerification | null>;

  // A new request supersedes the previous series for that (email, purpose) (docs/03 §3.3.3).
  abstract replace(
    input: CreateEmailVerificationInput,
    tx?: TransactionHandle,
  ): Promise<EmailVerification>;

  abstract incrementAttempts(id: string, tx?: TransactionHandle): Promise<number>;

  abstract issueTicket(
    id: string,
    input: IssueTicketInput,
    tx?: TransactionHandle,
  ): Promise<EmailVerification>;

  abstract markConsumed(id: string, consumedAt: Date, tx?: TransactionHandle): Promise<void>;

  // Burning the record after too many wrong codes, and maintenance purges (docs/06 §6.3.2).
  abstract delete(id: string, tx?: TransactionHandle): Promise<void>;

  abstract deleteExpired(now: Date, tx?: TransactionHandle): Promise<number>;
}
