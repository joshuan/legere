// Session entity (docs/03 §3.3.2). The cookie carries an opaque token; the DB stores only its hash.
export type Session = {
  id: string;
  tokenHash: string;
  userId: string;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

// User-agent strings are stored truncated (docs/03 §3.3.2).
export const USER_AGENT_MAX_LENGTH = 512;

export function isSessionActive(session: Session, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}
