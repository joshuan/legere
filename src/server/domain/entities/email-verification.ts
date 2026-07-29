// EmailVerification entity (docs/03 §3.3.3): one active series per (email, purpose), keyed by email
// because during registration the user does not exist yet.
export type VerificationPurpose = 'REGISTRATION' | 'PASSWORD_RESET';

export type EmailVerification = {
  id: string;
  email: string;
  purpose: VerificationPurpose;
  codeHash: string;
  attempts: number;
  expiresAt: Date;
  verifiedAt: Date | null;
  ticketHash: string | null;
  ticketExpiresAt: Date | null;
  consumedAt: Date | null;
  inviteId: string | null;
  passwordResetId: string | null;
  createdAt: Date;
};

// The record is burned after this many wrong codes (docs/08 §8.1.3 step 2).
export const MAX_CODE_ATTEMPTS = 5;

// A code is usable while it has not expired and the series has not been verified or consumed.
export function isCodeUsable(verification: EmailVerification, now: Date): boolean {
  return verification.consumedAt === null && verification.expiresAt.getTime() > now.getTime();
}

// The ticket issued at step 2 is single-use and short-lived (docs/03 §3.3.3).
export function isTicketUsable(verification: EmailVerification, now: Date): boolean {
  return (
    verification.verifiedAt !== null &&
    verification.consumedAt === null &&
    verification.ticketExpiresAt !== null &&
    verification.ticketExpiresAt.getTime() > now.getTime()
  );
}
