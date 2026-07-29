import { Injectable } from '@nestjs/common';
import type { EmailVerification as PrismaEmailVerification } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type {
  EmailVerification,
  VerificationPurpose,
} from '../../domain/entities/email-verification';
import {
  EmailVerificationRepository,
  type CreateEmailVerificationInput,
  type IssueTicketInput,
} from '../../domain/repositories/email-verification.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaEmailVerification): EmailVerification {
  return {
    id: row.id,
    email: row.email,
    purpose: row.purpose,
    codeHash: row.codeHash,
    attempts: row.attempts,
    expiresAt: row.expiresAt,
    verifiedAt: row.verifiedAt,
    ticketHash: row.ticketHash,
    ticketExpiresAt: row.ticketExpiresAt,
    consumedAt: row.consumedAt,
    inviteId: row.inviteId,
    passwordResetId: row.passwordResetId,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaEmailVerificationRepository implements EmailVerificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findActive(
    email: string,
    purpose: VerificationPurpose,
    tx?: TransactionHandle,
  ): Promise<EmailVerification | null> {
    const row = await clientOf(this.prisma, tx).emailVerification.findUnique({
      where: { email_purpose: { email, purpose } },
    });
    return row === null ? null : toDomain(row);
  }

  async findByTicketHash(
    ticketHash: string,
    tx?: TransactionHandle,
  ): Promise<EmailVerification | null> {
    const row = await clientOf(this.prisma, tx).emailVerification.findUnique({
      where: { ticketHash },
    });
    return row === null ? null : toDomain(row);
  }

  // One active series per (email, purpose): a new request supersedes the previous one, resetting
  // attempts and any issued ticket (docs/03 §3.3.3).
  async replace(
    input: CreateEmailVerificationInput,
    tx?: TransactionHandle,
  ): Promise<EmailVerification> {
    const fresh = {
      codeHash: input.codeHash,
      attempts: 0,
      expiresAt: input.expiresAt,
      verifiedAt: null,
      ticketHash: null,
      ticketExpiresAt: null,
      consumedAt: null,
      inviteId: input.inviteId,
      passwordResetId: input.passwordResetId,
      createdAt: new Date(),
    };
    const row = await clientOf(this.prisma, tx).emailVerification.upsert({
      where: { email_purpose: { email: input.email, purpose: input.purpose } },
      create: { email: input.email, purpose: input.purpose, ...fresh },
      update: fresh,
    });
    return toDomain(row);
  }

  async incrementAttempts(id: string, tx?: TransactionHandle): Promise<number> {
    const row = await clientOf(this.prisma, tx).emailVerification.update({
      where: { id },
      data: { attempts: { increment: 1 } },
    });
    return row.attempts;
  }

  async issueTicket(
    id: string,
    input: IssueTicketInput,
    tx?: TransactionHandle,
  ): Promise<EmailVerification> {
    const row = await clientOf(this.prisma, tx).emailVerification.update({
      where: { id },
      data: input,
    });
    return toDomain(row);
  }

  async markConsumed(id: string, consumedAt: Date, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).emailVerification.update({
      where: { id },
      data: { consumedAt },
    });
  }

  async delete(id: string, tx?: TransactionHandle): Promise<void> {
    await clientOf(this.prisma, tx).emailVerification.delete({ where: { id } });
  }

  async deleteExpired(now: Date, tx?: TransactionHandle): Promise<number> {
    const result = await clientOf(this.prisma, tx).emailVerification.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return result.count;
  }
}
