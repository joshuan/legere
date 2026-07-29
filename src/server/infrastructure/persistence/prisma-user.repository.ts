import { Injectable } from '@nestjs/common';
import { Prisma, type User as PrismaUser } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { User } from '../../domain/entities/user';
import { ConflictError } from '../../domain/errors/domain-error';
import {
  UserRepository,
  type CreateUserInput,
  type UpdateUserInput,
} from '../../domain/repositories/user.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

function toDomain(row: PrismaUser): User {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.passwordHash,
    displayName: row.displayName,
    role: row.role,
    language: row.language,
    theme: row.theme,
    deactivatedAt: row.deactivatedAt,
    createdAt: row.createdAt,
  };
}

@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string, tx?: TransactionHandle): Promise<User | null> {
    const row = await clientOf(this.prisma, tx).user.findFirst({ where: { id, deletedAt: null } });
    return row === null ? null : toDomain(row);
  }

  async findActiveByEmail(email: string, tx?: TransactionHandle): Promise<User | null> {
    const row = await clientOf(this.prisma, tx).user.findFirst({
      where: { email, deletedAt: null },
    });
    return row === null ? null : toDomain(row);
  }

  countActive(tx?: TransactionHandle): Promise<number> {
    return clientOf(this.prisma, tx).user.count({ where: { deletedAt: null } });
  }

  // Transaction-scoped advisory lock: the second onboarding blocks here until the first commits,
  // then sees the admin it created. The key is an arbitrary constant private to this lock.
  async lockOnboarding(tx: TransactionHandle): Promise<void> {
    // $executeRaw, not $queryRaw: the function returns void, which Prisma cannot deserialize.
    await clientOf(this.prisma, tx).$executeRaw`SELECT pg_advisory_xact_lock(4919723001)`;
  }

  countActiveAdmins(tx?: TransactionHandle): Promise<number> {
    return clientOf(this.prisma, tx).user.count({
      where: { deletedAt: null, deactivatedAt: null, role: 'ADMIN' },
    });
  }

  async create(input: CreateUserInput, tx?: TransactionHandle): Promise<User> {
    try {
      const row = await clientOf(this.prisma, tx).user.create({ data: input });
      return toDomain(row);
    } catch (error) {
      // P2002 here can only come from users_email_active_uq: two registrations raced for the same
      // address and the index picked a winner (docs/04 §4.3).
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictError('EMAIL_ALREADY_REGISTERED', 'This email is already registered');
      }
      throw error;
    }
  }

  async update(id: string, input: UpdateUserInput, tx?: TransactionHandle): Promise<User> {
    const row = await clientOf(this.prisma, tx).user.update({ where: { id }, data: input });
    return toDomain(row);
  }
}
