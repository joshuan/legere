import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import {
  SettingsRepository,
  type SettingValue,
} from '../../domain/repositories/settings.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

@Injectable()
export class PrismaSettingsRepository extends SettingsRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async read(key: string, tx?: TransactionHandle): Promise<SettingValue> {
    const row = await clientOf(this.prisma, tx).setting.findUnique({ where: { key } });
    return row === null ? null : toSettingValue(row.value);
  }

  async write(key: string, value: SettingValue, tx?: TransactionHandle): Promise<void> {
    // Prisma spells a stored JSON null differently from "leave this alone", and only the first is
    // ever meant here.
    const stored = value === null ? Prisma.JsonNull : value;
    await clientOf(this.prisma, tx).setting.upsert({
      where: { key },
      create: { key, value: stored },
      update: { value: stored },
    });
  }
}

// Prisma's JsonValue and ours are the same shape by different names; the round trip through JSON is
// what makes that a fact rather than an assertion.
function toSettingValue(value: Prisma.JsonValue): SettingValue {
  const parsed: unknown = JSON.parse(JSON.stringify(value));
  return isSettingValue(parsed) ? parsed : null;
}

function isSettingValue(value: unknown): value is SettingValue {
  if (value === null) return true;
  if (['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isSettingValue);
  return typeof value === 'object' && Object.values({ ...value }).every(isSettingValue);
}
