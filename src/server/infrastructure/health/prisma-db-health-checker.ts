import { Injectable } from '@nestjs/common';
import { DbHealthChecker } from '../../application/health/ports';
import { PrismaService } from '../persistence/prisma.service';

@Injectable()
export class PrismaDbHealthChecker extends DbHealthChecker {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async ping(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
}
