import { Injectable } from '@nestjs/common';
import type { TransactionHandle } from '../../application/ports/unit-of-work';
import type { Person } from '../../domain/entities/person';
import { foldName } from '../../domain/value-objects/name-fold';
import {
  PersonRepository,
  type PersonWithCount,
} from '../../domain/repositories/person.repository';
import { clientOf } from './prisma-client';
import { PrismaService } from './prisma.service';

type PersonRow = {
  id: string;
  name: string;
  note: string | null;
  createdAt: Date;
  deletedAt: Date | null;
};

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    note: row.note,
    createdAt: row.createdAt,
    deletedAt: row.deletedAt,
  };
}

@Injectable()
export class PrismaPersonRepository extends PersonRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listActive(tx?: TransactionHandle): Promise<PersonWithCount[]> {
    const rows = await clientOf(this.prisma, tx).person.findMany({
      where: { deletedAt: null },
      orderBy: { name: 'asc' },
      include: { _count: { select: { documents: true } } },
    });
    return rows.map((row) => ({ ...toPerson(row), documentCount: row._count.documents }));
  }

  async findById(id: string, tx?: TransactionHandle): Promise<Person | null> {
    const row = await clientOf(this.prisma, tx).person.findFirst({
      where: { id, deletedAt: null },
    });
    return row === null ? null : toPerson(row);
  }

  async findByIds(ids: string[], tx?: TransactionHandle): Promise<Person[]> {
    if (ids.length === 0) return [];
    const rows = await clientOf(this.prisma, tx).person.findMany({
      where: { id: { in: ids }, deletedAt: null },
      orderBy: { name: 'asc' },
    });
    return rows.map(toPerson);
  }

  async findByName(name: string, tx?: TransactionHandle): Promise<Person | null> {
    // 🔒 Matched on the fold, not on ILIKE: the C-collation database folds ASCII alone, and
    // ШЕРШНЕВ has to find Шершнев (docs/03 §3.3.19).
    const row = await clientOf(this.prisma, tx).person.findFirst({
      where: { nameFolded: foldName(name), deletedAt: null },
    });
    return row === null ? null : toPerson(row);
  }

  async create(
    input: { name: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Person> {
    const row = await clientOf(this.prisma, tx).person.create({
      data: { name: input.name.trim(), nameFolded: foldName(input.name), note: input.note ?? null },
    });
    return toPerson(row);
  }

  async update(
    id: string,
    input: { name?: string; note?: string | null },
    tx?: TransactionHandle,
  ): Promise<Person> {
    const row = await clientOf(this.prisma, tx).person.update({
      where: { id },
      data: {
        ...(input.name === undefined
          ? {}
          : { name: input.name.trim(), nameFolded: foldName(input.name) }),
        ...(input.note === undefined ? {} : { note: input.note }),
      },
    });
    return toPerson(row);
  }

  async softDelete(id: string, deletedAt: Date, tx?: TransactionHandle): Promise<void> {
    // The links stay: a soft-deleted person is one nobody may pick again, not one who was never on
    // the document (ADR-015).
    await clientOf(this.prisma, tx).person.update({ where: { id }, data: { deletedAt } });
  }

  async listForDocument(documentId: string, tx?: TransactionHandle): Promise<Person[]> {
    const rows = await clientOf(this.prisma, tx).documentPerson.findMany({
      where: { documentId, person: { deletedAt: null } },
      include: { person: true },
      orderBy: { person: { name: 'asc' } },
    });
    return rows.map((row) => toPerson(row.person));
  }

  async moveDocumentLinks(fromIds: string[], toId: string, tx?: TransactionHandle): Promise<void> {
    if (fromIds.length === 0) return;
    const client = clientOf(this.prisma, tx);

    // Written as create-then-delete rather than an UPDATE, because a document that named two of the
    // merged rows would collide on the primary key half way through. `skipDuplicates` is exactly the
    // collapse we want; the old rows go afterwards.
    const links = await client.documentPerson.findMany({
      where: { personId: { in: fromIds } },
      select: { documentId: true },
    });
    if (links.length > 0) {
      await client.documentPerson.createMany({
        data: links.map((link) => ({ documentId: link.documentId, personId: toId })),
        skipDuplicates: true,
      });
    }
    await client.documentPerson.deleteMany({ where: { personId: { in: fromIds } } });
  }

  async setForDocument(
    documentId: string,
    personIds: string[],
    tx?: TransactionHandle,
  ): Promise<void> {
    const client = clientOf(this.prisma, tx);
    // An empty set means "nobody", which is a deleteMany with no exclusion — `notIn: []` would be a
    // uuid comparison against nothing, and Prisma rejects the placeholder that would need.
    await client.documentPerson.deleteMany({
      where: {
        documentId,
        ...(personIds.length === 0 ? {} : { personId: { notIn: personIds } }),
      },
    });
    if (personIds.length > 0) {
      await client.documentPerson.createMany({
        data: personIds.map((personId) => ({ documentId, personId })),
        skipDuplicates: true,
      });
    }
  }
}
