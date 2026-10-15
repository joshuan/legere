import { Injectable } from '@nestjs/common';
import type { FileSignature } from '@prisma/client';
import {
  MAX_SIGNATURES_PER_FILE,
  signatureReportSchema,
} from '../../../shared/contracts/signatures';
import { UnprocessableError } from '../../domain/errors/domain-error';
import {
  FileSignatureRepository,
  type FileSignatureRecord,
} from '../../domain/repositories/file-signature.repository';
import { PrismaService } from './prisma.service';

function record(row: FileSignature): FileSignatureRecord {
  return { ...row, report: signatureReportSchema.parse(row.report) };
}

@Injectable()
export class PrismaFileSignatureRepository extends FileSignatureRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async list(fileIds: readonly string[]): Promise<FileSignatureRecord[]> {
    return (
      await this.prisma.fileSignature.findMany({
        where: { fileId: { in: [...fileIds] } },
        orderBy: { createdAt: 'asc' },
      })
    ).map(record);
  }

  async add(input: Omit<FileSignatureRecord, 'createdAt'>): Promise<FileSignatureRecord> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM files WHERE id = ${input.fileId}::uuid FOR UPDATE`;
      const existing = await tx.fileSignature.findUnique({
        where: { fileId_contentHash: { fileId: input.fileId, contentHash: input.contentHash } },
      });
      if (existing !== null) return record(existing);
      if (
        (await tx.fileSignature.count({ where: { fileId: input.fileId } })) >=
        MAX_SIGNATURES_PER_FILE
      ) {
        throw new UnprocessableError(
          'VALIDATION_FAILED',
          'This original already has 20 signatures',
        );
      }
      return record(await tx.fileSignature.create({ data: input }));
    });
  }

  async remove(id: string): Promise<void> {
    await this.prisma.fileSignature.deleteMany({ where: { id } });
  }
}
